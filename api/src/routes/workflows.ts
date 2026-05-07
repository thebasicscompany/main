/**
 * /v1/runtime/workflows — Phase 10 + 10.5.
 *
 *   GET    /v1/runtime/workflows                 — list (paginated, ?enabled=...)
 *   GET    /v1/runtime/workflows/:id             — single
 *   POST   /v1/runtime/workflows                 — create
 *   PATCH  /v1/runtime/workflows/:id             — partial update
 *   DELETE /v1/runtime/workflows/:id             — hard delete (followup: soft)
 *   POST   /v1/runtime/workflows/:id/run-now     — manual trigger OR cron-fired
 *
 * Auth:
 *  - CRUD routes: workspace JWT (per-route requireWorkspaceJwt below).
 *  - run-now: workspace JWT OR shared cron secret (X-Cron-Secret).
 *    Cron path resolves workspace_id from the workflow row server-side.
 *
 * Locked decisions:
 *  - Phase 10.5 validates `schedule` against AWS EventBridge syntax
 *    (cron(...) or rate(...)). Bare 5-field cron is rejected with 400.
 *  - Built-in workflow IDs (`hello-world`, `agent-helloworld`) are NOT
 *    stored in this table — they bypass DB lookup entirely. Listing
 *    therefore never includes them, and `/run-now` with a built-in id
 *    returns 404 (use POST /v1/runtime/runs for built-ins).
 *  - DELETE is hard-delete v1. Already-executed runs keep their
 *    `workflow_id` reference but the FK is soft (no DB-level constraint).
 *    Followup: soft-delete + tombstone before the first design partner.
 *  - Lifecycle hooks (Phase 10.5): create/patch/delete call into
 *    api/src/lib/eventbridge.ts to upsert/delete per-workflow rules.
 *    The helpers no-op when EVENTBRIDGE_RULE_PREFIX is unset (dev/test).
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  AnthropicUnavailableError,
  BrowserbaseUnavailableError,
} from '../lib/errors.js'
import {
  deleteWorkflowSchedule,
  upsertWorkflowSchedule,
  validateScheduleExpression,
} from '../lib/eventbridge.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { requireCronOrWorkspaceJwt } from '../middleware/cronAuth.js'
import { requireWorkspaceJwt } from '../middleware/jwt.js'
import { logger } from '../middleware/logger.js'
import {
  startRun,
  WorkflowDisabledError,
  WorkflowNotFoundError,
} from '../orchestrator/run.js'
import {
  create as createWorkflow,
  get as getWorkflow,
  getById as getWorkflowById,
  list as listWorkflows,
  remove as deleteWorkflow,
  update as updateWorkflow,
  type WorkflowRecord,
} from '../orchestrator/workflowsRepo.js'

// `workspace` is optional because the run-now endpoint also accepts
// cron-secret auth, which doesn't carry a workspace JWT. CRUD routes
// apply requireWorkspaceJwt at the per-route level (below), so the
// app-level mount in app.ts no longer needs a prefix-wide guard for
// /v1/runtime/workflows/*.
type Vars = {
  requestId: string
  workspace?: WorkspaceToken
  cronTrigger?: boolean
}

export const workflowsRoute = new Hono<{ Variables: Vars }>()

// Phase 10.5: every CRUD route below applies requireWorkspaceJwt
// individually. The run-now route uses requireCronOrWorkspaceJwt so
// EventBridge can call it with a shared cron secret instead of a JWT.
// This is set up at the per-route level (rather than via a `.use()` on
// the sub-app) so the cron-only path doesn't accidentally inherit the
// JWT requirement and 401 on every cron fire.

// =============================================================================
// Schemas.
// =============================================================================

const listQuerySchema = z.object({
  enabled: z
    .union([z.literal('true'), z.literal('false')])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

// `requiredCredentials` accepts nested unknowns — validation is
// structural (object) only. Phase 11 lifts the credential-shape contract.
const requiredCredentialsSchema = z.record(z.string(), z.unknown())

// Phase 11: each check_modules entry is `{ name, params }`. `name` keys
// into the registry; `params` is whatever the primitive expects (free
// form). Cap at 20 entries per workflow — same conservative limit as the
// previous string-only schema.
const checkModuleEntrySchema = z.object({
  name: z.string().min(1).max(64),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({}),
})
const checkModulesSchema = z.array(checkModuleEntrySchema).max(20)

// Schedule validator: AWS EventBridge expects either
// `cron(min hour day month day-of-week year)` (six fields, with `?`
// substituting day-of-week or day-of-month) or `rate(N unit)`. We
// validate at the route layer so a malformed string surfaces as a 400
// instead of a runtime PutRule failure (Phase 10.5).
const scheduleField = z
  .string()
  .min(1)
  .superRefine((val, ctx) => {
    const err = validateScheduleExpression(val)
    if (err) {
      ctx.addIssue({
        code: 'custom',
        message: err,
      })
    }
  })

const createBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    prompt: z.string().min(1),
    schedule: scheduleField.nullable().optional(),
    required_credentials: requiredCredentialsSchema.optional(),
    check_modules: checkModulesSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).optional(),
    // null clears the schedule. Empty string / malformed expressions are
    // rejected by `scheduleField` above.
    schedule: scheduleField.nullable().optional(),
    required_credentials: requiredCredentialsSchema.optional(),
    check_modules: checkModulesSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  // Empty patch isn't useful — reject so the caller gets explicit feedback.
  .refine((v) => Object.keys(v).length > 0, {
    message: 'patch body must have at least one field',
  })

// =============================================================================
// Serialization.
// =============================================================================

function serialize(w: WorkflowRecord): Record<string, unknown> {
  return {
    id: w.id,
    workspace_id: w.workspaceId,
    name: w.name,
    prompt: w.prompt,
    schedule: w.schedule,
    required_credentials: w.requiredCredentials,
    check_modules: w.checkModules,
    enabled: w.enabled,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  }
}

// =============================================================================
// Routes.
// =============================================================================

workflowsRoute.get('/', requireWorkspaceJwt, async (c) => {
  const workspace = c.get('workspace')!
  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams.entries()),
  )
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        code: 'validation_failed',
        issues: z.flattenError(parsed.error),
      },
      400,
    )
  }
  const q = parsed.data
  const limit = q.limit ?? 50
  const offset = q.offset ?? 0
  const records = await listWorkflows({
    workspaceId: workspace.workspace_id,
    ...(q.enabled !== undefined ? { enabled: q.enabled === 'true' } : {}),
    limit,
    offset,
  })
  return c.json(
    {
      workflows: records.map(serialize),
      limit,
      offset,
    },
    200,
  )
})

workflowsRoute.get('/:id', requireWorkspaceJwt, async (c) => {
  const workspace = c.get('workspace')!
  const id = c.req.param('id')
  const w = await getWorkflow(workspace.workspace_id, id)
  if (!w) return c.json({ error: 'workflow_not_found' }, 404)
  return c.json(serialize(w), 200)
})

workflowsRoute.post(
  '/',
  requireWorkspaceJwt,
  zValidator('json', createBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'invalid_request',
          code: 'validation_failed',
          issues: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  async (c) => {
    const workspace = c.get('workspace')!
    const requestId = c.get('requestId')
    const body = c.req.valid('json')
    const created = await createWorkflow({
      workspaceId: workspace.workspace_id,
      name: body.name,
      prompt: body.prompt,
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.required_credentials !== undefined
        ? { requiredCredentials: body.required_credentials }
        : {}),
      ...(body.check_modules !== undefined
        ? { checkModules: body.check_modules }
        : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    })

    // Phase 10.5 lifecycle hook — only attempt rule creation when the
    // workflow has a schedule. The helper itself is a no-op when
    // EVENTBRIDGE_RULE_PREFIX is unset (dev / test).
    if (created.schedule !== null) {
      try {
        await upsertWorkflowSchedule({
          id: created.id,
          workspaceId: created.workspaceId,
          schedule: created.schedule,
          enabled: created.enabled,
        })
      } catch (err) {
        // Schedule upsert failure on create is logged but does NOT roll
        // back the workflow row — the row is the source of truth and the
        // operator can re-trigger the upsert via PATCH. Logging keeps
        // the failure visible in CloudWatch.
        logger.error(
          {
            requestId,
            workspace_id: workspace.workspace_id,
            workflow_id: created.id,
            err: { name: (err as Error).name, message: (err as Error).message },
          },
          'workflow create: eventbridge upsert failed (row persisted)',
        )
      }
    }
    return c.json(serialize(created), 201)
  },
)

workflowsRoute.patch(
  '/:id',
  requireWorkspaceJwt,
  zValidator('json', patchBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'invalid_request',
          code: 'validation_failed',
          issues: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  async (c) => {
    const workspace = c.get('workspace')!
    const requestId = c.get('requestId')
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const updated = await updateWorkflow(workspace.workspace_id, id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.required_credentials !== undefined
        ? { requiredCredentials: body.required_credentials }
        : {}),
      ...(body.check_modules !== undefined
        ? { checkModules: body.check_modules }
        : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    })
    if (!updated) return c.json({ error: 'workflow_not_found' }, 404)

    // Phase 10.5 lifecycle hook — re-sync the EventBridge rule whenever
    // anything affecting fire behavior (schedule, enabled) might have
    // changed. The helper handles all three cases: schedule cleared
    // (delete), schedule set (upsert), enabled toggled (state change).
    if (body.schedule !== undefined || body.enabled !== undefined) {
      try {
        await upsertWorkflowSchedule({
          id: updated.id,
          workspaceId: updated.workspaceId,
          schedule: updated.schedule,
          enabled: updated.enabled,
        })
      } catch (err) {
        logger.error(
          {
            requestId,
            workspace_id: workspace.workspace_id,
            workflow_id: updated.id,
            err: { name: (err as Error).name, message: (err as Error).message },
          },
          'workflow patch: eventbridge upsert failed (row updated)',
        )
      }
    }

    return c.json(serialize(updated), 200)
  },
)

workflowsRoute.delete('/:id', requireWorkspaceJwt, async (c) => {
  const workspace = c.get('workspace')!
  const requestId = c.get('requestId')
  const id = c.req.param('id')
  const result = await deleteWorkflow(workspace.workspace_id, id)
  if (!result.deleted) return c.json({ error: 'workflow_not_found' }, 404)

  // Phase 10.5 lifecycle hook — drop the per-workflow rule. The helper
  // is idempotent (no-op if the rule never existed).
  try {
    await deleteWorkflowSchedule(id)
  } catch (err) {
    logger.error(
      {
        requestId,
        workspace_id: workspace.workspace_id,
        workflow_id: id,
        err: { name: (err as Error).name, message: (err as Error).message },
      },
      'workflow delete: eventbridge cleanup failed (row already removed)',
    )
  }

  return c.json({ deleted: true, id }, 200)
})

// Phase 10.5: run-now accepts EITHER a workspace JWT (humans) OR a
// shared cron secret (EventBridge). The middleware handles both paths
// and exposes `cronTrigger=true` when called via cron — in that case
// we resolve workspace_id from the workflow row by id.
workflowsRoute.post('/:id/run-now', requireCronOrWorkspaceJwt, async (c) => {
  const workspace = c.get('workspace')
  const cronTrigger = c.get('cronTrigger') === true
  const requestId = c.get('requestId')
  const id = c.req.param('id')

  // Resolve the workflow + workspace_id depending on auth path.
  let workflow: WorkflowRecord | null
  let workspaceId: string
  if (workspace) {
    workspaceId = workspace.workspace_id
    workflow = await getWorkflow(workspaceId, id)
  } else if (cronTrigger) {
    // Cron path: look up by id alone, then derive workspace_id from the
    // row. Cross-workspace concerns don't apply to cron-fired calls
    // (EventBridge rules are workspace-aware via the rule name).
    workflow = await getWorkflowById(id)
    if (!workflow) return c.json({ error: 'workflow_not_found' }, 404)
    workspaceId = workflow.workspaceId
  } else {
    // Defense-in-depth: middleware should have already 401'd. If we
    // somehow get here without either, return 401.
    return c.json({ error: 'invalid_token', message: 'unauthenticated' }, 401)
  }

  if (!workflow) return c.json({ error: 'workflow_not_found' }, 404)
  if (!workflow.enabled) {
    return c.json({ error: 'workflow_disabled', workflow_id: id }, 409)
  }

  try {
    const result = await startRun({
      workspaceId,
      workflowId: id,
    })
    logger.info(
      {
        requestId,
        workspace_id: workspaceId,
        run_id: result.runId,
        workflow_id: id,
        browserbase_session_id: result.browserbaseSessionId,
        trigger: cronTrigger ? 'cron' : 'manual',
      },
      'workflow run-now: started',
    )
    return c.json(
      {
        run_id: result.runId,
        browserbase_session_id: result.browserbaseSessionId,
        live_url: result.liveUrl,
        status: 'running',
        trigger: cronTrigger ? 'cron' : 'manual',
      },
      200,
    )
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return c.json({ error: 'workflow_not_found' }, 404)
    }
    if (err instanceof WorkflowDisabledError) {
      return c.json({ error: 'workflow_disabled', workflow_id: id }, 409)
    }
    if (err instanceof BrowserbaseUnavailableError) {
      return c.json({ error: 'browserbase_unavailable' }, 503)
    }
    if (err instanceof AnthropicUnavailableError) {
      return c.json({ error: 'anthropic_unavailable' }, 503)
    }
    logger.error(
      {
        requestId,
        workspace_id: workspaceId,
        workflow_id: id,
        err: { name: (err as Error).name, message: (err as Error).message },
      },
      'workflow run-now: startRun failed',
    )
    throw err
  }
})

// =============================================================================
// Phase 10.5: cron-driven runs (DONE).
//
// EventBridge wiring landed in this phase:
//   - sst.config.ts provisions: connection (carries X-Cron-Secret),
//     API destination (templated to /v1/runtime/workflows/*/run-now),
//     IAM role for EventBridge to invoke the destination.
//   - api/src/lib/eventbridge.ts manages per-workflow rules at runtime
//     (upsert on create/patch, delete on delete).
//   - The /run-now route above accepts EITHER workspace JWT OR
//     X-Cron-Secret header, resolving workspace_id from the row when
//     called via cron.
// =============================================================================

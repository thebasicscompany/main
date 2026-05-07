/**
 * /v1/runtime/runs — Phase 01 + Phase 04B contract.
 *
 *   POST /v1/runtime/runs                                                 — start a run
 *   GET  /v1/runtime/runs/:id                                             — snapshot
 *   GET  /v1/runtime/runs/:id/events                                      — SSE event stream
 *   POST /v1/runtime/runs/:runId/approvals/:approvalId/resolve            — resolve approval
 *
 * Auth: workspace JWT (mounted in app.ts via requireWorkspaceJwt).
 *
 * Phase 05 swaps runState/eventbus for DB-backed implementations; the
 * route handlers here should not need to change.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  AnthropicUnavailableError,
  BrowserbaseUnavailableError,
  RunAccessDeniedError,
  RunNotFoundError,
} from '../lib/errors.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { logger } from '../middleware/logger.js'
import {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  get as getApproval,
  resolve as resolveApproval,
} from '../orchestrator/approvalsRepo.js'
import { signalResolution } from '../orchestrator/approvalSignal.js'
import {
  listRunSteps,
  listToolCalls,
  nextStepIndex,
  recordStepStart,
} from '../orchestrator/auditWriter.js'
import { subscribe, publish } from '../orchestrator/eventbus.js'
import {
  startRun,
  WorkflowDisabledError,
  WorkflowNotFoundError,
} from '../orchestrator/run.js'
import {
  assertWorkspaceMatch,
  list as listRuns,
  update as updateRunState,
} from '../orchestrator/runState.js'
import {
  isTakeoverActive,
  markTakeoverEnded,
  markTakeoverStarted,
} from '../orchestrator/takeoverSignal.js'
import { create as createTrustGrant } from '../orchestrator/trustLedger.js'

const startRunBodySchema = z
  .object({
    workflow_id: z.string().min(1),
  })
  .strict()

type Vars = { requestId: string; workspace: WorkspaceToken }

export const runsRoute = new Hono<{ Variables: Vars }>()

/**
 * POST /v1/runtime/runs — kick off the hello-world workflow.
 *
 * Phase 01 only supports `workflow_id: 'hello-world'`; anything else is
 * 400 `unknown_workflow`. If Browserbase keys are missing, the
 * orchestrator throws `BrowserbaseUnavailableError`, mapped here to 503.
 */
runsRoute.post(
  '/',
  zValidator('json', startRunBodySchema, (result, c) => {
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
    const body = c.req.valid('json')
    const requestId = c.get('requestId')
    const workspace = c.get('workspace')

    // Phase 10: widen validation. The orchestrator owns workflow
    // resolution — built-in IDs are matched by name, anything else is
    // treated as a runtime_workflows.id and looked up against the
    // calling workspace. The route used to pre-check against the
    // built-in enum and return 400 for unknown ids; we keep that 400
    // status code (under a different error name) for unknown workflows
    // so existing clients keep getting an early-validation-style error
    // shape.
    try {
      const result = await startRun({
        workspaceId: workspace.workspace_id,
        workflowId: body.workflow_id,
      })
      logger.info(
        {
          requestId,
          workspace_id: workspace.workspace_id,
          run_id: result.runId,
          browserbase_session_id: result.browserbaseSessionId,
        },
        'run started',
      )
      return c.json(
        {
          run_id: result.runId,
          browserbase_session_id: result.browserbaseSessionId,
          live_url: result.liveUrl,
          status: 'running',
        },
        200,
      )
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        // Preserves the prior 400 status code for unknown workflow ids
        // (the v0 route returned 400 + `unknown_workflow`), so existing
        // clients keep parsing the same error envelope.
        return c.json({ error: 'unknown_workflow' }, 400)
      }
      if (err instanceof WorkflowDisabledError) {
        return c.json(
          { error: 'workflow_disabled', workflow_id: body.workflow_id },
          409,
        )
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
          err: {
            name: (err as Error).name,
            message: (err as Error).message,
          },
        },
        'startRun failed',
      )
      throw err
    }
  },
)

/**
 * GET /v1/runtime/runs — list runs scoped to the calling workspace.
 *
 * Query params (all optional):
 *   ?status=<run-status>         filter by status
 *   ?workflow_id=<id>            filter by workflow id
 *   ?started_after=<ISO>         lower bound on started_at (inclusive)
 *   ?started_before=<ISO>        upper bound on started_at (inclusive)
 *   ?limit=<n>                   page size, 1..100, default 50
 *   ?offset=<n>                  pagination offset, default 0
 *
 * Always sorted by started_at descending (newest first).
 */
const listQuerySchema = z.object({
  status: z.string().optional(),
  workflow_id: z.string().optional(),
  started_after: z.iso.datetime().optional(),
  started_before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

runsRoute.get('/', async (c) => {
  const workspace = c.get('workspace')
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
  const records = await listRuns({
    workspaceId: workspace.workspace_id,
    ...(q.status !== undefined ? { status: q.status } : {}),
    ...(q.workflow_id !== undefined ? { workflowId: q.workflow_id } : {}),
    ...(q.started_after !== undefined ? { startedAfter: q.started_after } : {}),
    ...(q.started_before !== undefined
      ? { startedBefore: q.started_before }
      : {}),
    limit,
    offset,
  })
  return c.json(
    {
      runs: records.map((r) => ({
        run_id: r.runId,
        workflow_id: r.workflowId,
        status: r.status,
        browserbase_session_id: r.browserbaseSessionId,
        live_url: r.liveUrl,
        started_at: r.startedAt,
        ...(r.completedAt ? { completed_at: r.completedAt } : {}),
      })),
      limit,
      offset,
    },
    200,
  )
})

/**
 * GET /v1/runtime/runs/:id — snapshot of a run.
 *
 * Phase 05: when `?include=steps` and/or `?include=tool_calls` is set, the
 * response includes the run's step timeline / tool-call audit log inline.
 * Comma-separated values are accepted (`?include=steps,tool_calls`).
 */
const includeQuerySchema = z.object({
  include: z.string().optional(),
})

runsRoute.get('/:id', async (c) => {
  const runId = c.req.param('id')
  const workspace = c.get('workspace')

  const parsed = includeQuerySchema.safeParse(
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
  const includes = (parsed.data.include ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const includeSteps = includes.includes('steps')
  const includeToolCalls = includes.includes('tool_calls')

  try {
    const r = await assertWorkspaceMatch(runId, workspace.workspace_id)
    const body: Record<string, unknown> = {
      run_id: r.runId,
      workflow_id: r.workflowId,
      status: r.status,
      browserbase_session_id: r.browserbaseSessionId,
      live_url: r.liveUrl,
      started_at: r.startedAt,
      ...(r.completedAt ? { completed_at: r.completedAt } : {}),
    }
    if (includeSteps) {
      const steps = await listRunSteps(runId)
      body.steps = steps.map((s) => ({
        step_id: s.stepId,
        run_id: s.runId,
        step_index: s.stepIndex,
        kind: s.kind,
        payload: s.payload,
        created_at: s.createdAt,
      }))
    }
    if (includeToolCalls) {
      const calls = await listToolCalls(runId)
      body.tool_calls = calls.map((tc) => ({
        tool_call_id: tc.toolCallId,
        run_id: tc.runId,
        step_index: tc.stepIndex,
        tool_name: tc.toolName,
        params: tc.params,
        result: tc.result,
        error: tc.error,
        screenshot_s3_key: tc.screenshotS3Key,
        approval_id: tc.approvalId,
        trust_grant_id: tc.trustGrantId,
        model_latency_ms: tc.modelLatencyMs,
        browser_latency_ms: tc.browserLatencyMs,
        cost_cents: tc.costCents,
        started_at: tc.startedAt,
        completed_at: tc.completedAt,
      }))
    }
    return c.json(body, 200)
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      return c.json({ error: 'run_not_found' }, 404)
    }
    if (err instanceof RunAccessDeniedError) {
      return c.json({ error: 'forbidden' }, 403)
    }
    throw err
  }
})

/**
 * GET /v1/runtime/runs/:id/steps — paginated step timeline.
 *
 * Workspace ownership is enforced before the listing query. Pagination
 * mirrors the `/runs` endpoint.
 */
const auditPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

runsRoute.get('/:id/steps', async (c) => {
  const runId = c.req.param('id')
  const workspace = c.get('workspace')
  const parsed = auditPageQuerySchema.safeParse(
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
  const limit = parsed.data.limit ?? 100
  const offset = parsed.data.offset ?? 0

  try {
    await assertWorkspaceMatch(runId, workspace.workspace_id)
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      return c.json({ error: 'run_not_found' }, 404)
    }
    if (err instanceof RunAccessDeniedError) {
      return c.json({ error: 'forbidden' }, 403)
    }
    throw err
  }

  const steps = await listRunSteps(runId, limit, offset)
  return c.json(
    {
      steps: steps.map((s) => ({
        step_id: s.stepId,
        run_id: s.runId,
        step_index: s.stepIndex,
        kind: s.kind,
        payload: s.payload,
        created_at: s.createdAt,
      })),
      limit,
      offset,
    },
    200,
  )
})

/**
 * GET /v1/runtime/runs/:id/tool-calls — paginated tool-call audit log.
 *
 * The full audit row including base64 screenshot bytes (Phase 05.5 will
 * move screenshots to S3 — see auditWriter.ts TODO) is returned.
 */
runsRoute.get('/:id/tool-calls', async (c) => {
  const runId = c.req.param('id')
  const workspace = c.get('workspace')
  const parsed = auditPageQuerySchema.safeParse(
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
  const limit = parsed.data.limit ?? 100
  const offset = parsed.data.offset ?? 0

  try {
    await assertWorkspaceMatch(runId, workspace.workspace_id)
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      return c.json({ error: 'run_not_found' }, 404)
    }
    if (err instanceof RunAccessDeniedError) {
      return c.json({ error: 'forbidden' }, 403)
    }
    throw err
  }

  const calls = await listToolCalls(runId, limit, offset)
  return c.json(
    {
      tool_calls: calls.map((tc) => ({
        tool_call_id: tc.toolCallId,
        run_id: tc.runId,
        step_index: tc.stepIndex,
        tool_name: tc.toolName,
        params: tc.params,
        result: tc.result,
        error: tc.error,
        screenshot_s3_key: tc.screenshotS3Key,
        approval_id: tc.approvalId,
        trust_grant_id: tc.trustGrantId,
        model_latency_ms: tc.modelLatencyMs,
        browser_latency_ms: tc.browserLatencyMs,
        cost_cents: tc.costCents,
        started_at: tc.startedAt,
        completed_at: tc.completedAt,
      })),
      limit,
      offset,
    },
    200,
  )
})

/**
 * GET /v1/runtime/runs/:id/events — Server-Sent Events stream.
 *
 * Replays the buffered history then tails live events. Closes the stream
 * once the run terminates (`run_completed` or `run_failed`).
 *
 * Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
 * `Connection: keep-alive`, `X-Accel-Buffering: no` (the last suppresses
 * nginx/ALB response buffering, otherwise events arrive in batches).
 */
runsRoute.get('/:id/events', async (c) => {
  const runId = c.req.param('id')
  const workspace = c.get('workspace')

  // Workspace authorization runs before opening the stream. The 404 / 403
  // bodies are surfaced as JSON, not an SSE error event.
  try {
    await assertWorkspaceMatch(runId, workspace.workspace_id)
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      return c.json({ error: 'run_not_found' }, 404)
    }
    if (err instanceof RunAccessDeniedError) {
      return c.json({ error: 'forbidden' }, 403)
    }
    throw err
  }

  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    const iter = subscribe(runId)
    for await (const evt of iter) {
      await stream.writeSSE({
        id: String(evt.id),
        event: evt.type,
        data: JSON.stringify(evt.data),
      })
      if (evt.type === 'run_completed' || evt.type === 'run_failed') {
        // The eventbus closes the channel right after these events, but
        // emit a clean break here so the client sees the stream end
        // immediately rather than waiting for the channel close to
        // propagate.
        break
      }
    }
  })
})

// =============================================================================
// Phase 08 — take-over / resume.
//
// `POST /:runId/takeover`  → orchestrator marks the run paused_by_user, the
//                            agent loop checks the flag between iterations
//                            and stops issuing CDP commands, the dashboard
//                            expands the live-view iframe full-bleed (per
//                            DESKTOP_INTEGRATION.md "Live-view & take-over").
// `POST /:runId/resume`    → orchestrator clears the flag, signals the
//                            agent loop's gate, the loop captures a fresh
//                            screenshot and injects a synthetic user turn
//                            with the new state, run goes back to running.
//
// Status name decision: `paused_by_user` (distinct from `paused`, which is
// the approval-pause state). Desktop already reads `paused_by_user`
// (`DESKTOP_INTEGRATION.md` line 198).
//
// Event names: `takeover_started` / `takeover_ended`. ARCHITECTURE.md:192
// describes a single `takeover_active` event; we expose two events so the
// dashboard can render the full lifecycle (mid-takeover vs resumed) — the
// `takeover_started` event payload carries the same semantics ARCHITECTURE
// described.
// =============================================================================

const takeoverBodySchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict()
  .or(z.object({}).strict())

/** Run statuses where take-over is not allowed (terminal or already gated). */
const NON_TAKEOVER_STATUSES = new Set([
  'completed',
  'failed',
  'verified',
  'unverified',
  // Approval-pause: the user must resolve the approval first. Allowing
  // takeover here would create an ambiguous resume target (the approval
  // gate is still pending in the dispatcher).
  'paused',
  // Already in takeover — only one active takeover at a time.
  'paused_by_user',
])

runsRoute.post(
  '/:runId/takeover',
  zValidator('json', takeoverBodySchema, (result, c) => {
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
    const runId = c.req.param('runId')
    const workspace = c.get('workspace')
    const body = c.req.valid('json') as { reason?: string }

    let run
    try {
      run = await assertWorkspaceMatch(runId, workspace.workspace_id)
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        return c.json({ error: 'run_not_found' }, 404)
      }
      if (err instanceof RunAccessDeniedError) {
        return c.json({ error: 'forbidden' }, 403)
      }
      throw err
    }

    if (NON_TAKEOVER_STATUSES.has(run.status) || isTakeoverActive(runId)) {
      return c.json(
        {
          error: 'takeover_not_allowed',
          status: run.status,
        },
        409,
      )
    }

    // Flip the in-memory flag first so the agent loop's next gate check
    // sees it. Then update DB-side status, emit SSE, persist the audit
    // step. Order matters: a publish ahead of the in-memory flip would
    // race the loop, but the dashboard sees the SSE event after the loop
    // is already gated, which is the safer ordering.
    const { startedAt } = markTakeoverStarted(runId, workspace.account_id)
    await updateRunState(runId, { status: 'paused_by_user' })

    publish(runId, {
      type: 'takeover_started',
      data: {
        run_id: runId,
        account_id: workspace.account_id,
        started_at: startedAt,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      },
    })

    // Persist the timeline anchor. The matching `ended` step is recorded
    // by the agent loop on resume (after the screenshot + synthetic
    // user-turn injection) so the timeline shows the full window.
    try {
      await recordStepStart({
        runId,
        stepIndex: nextStepIndex(runId),
        kind: 'user_takeover',
        payload: {
          phase: 'started',
          account_id: workspace.account_id,
          started_at: startedAt,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        },
      })
    } catch (err) {
      // Audit write is best-effort; the SSE + flag flip already
      // happened, so logging and continuing keeps the run consistent.
      logger.warn(
        {
          run_id: runId,
          err: { message: (err as Error).message },
        },
        'audit recordStepStart(user_takeover/started) failed; takeover proceeds',
      )
    }

    return c.json(
      {
        status: 'paused_by_user',
        started_at: startedAt,
      },
      200,
    )
  },
)

runsRoute.post('/:runId/resume', async (c) => {
  const runId = c.req.param('runId')
  const workspace = c.get('workspace')

  let run
  try {
    run = await assertWorkspaceMatch(runId, workspace.workspace_id)
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      return c.json({ error: 'run_not_found' }, 404)
    }
    if (err instanceof RunAccessDeniedError) {
      return c.json({ error: 'forbidden' }, 403)
    }
    throw err
  }

  // Resume only valid when the run is currently in takeover. Terminal
  // statuses (completed/failed/verified/unverified) can never be resumed.
  // `running` / `paused` (approval-pause) are not takeover states either.
  if (!isTakeoverActive(runId) || run.status !== 'paused_by_user') {
    return c.json(
      {
        error: 'resume_not_allowed',
        status: run.status,
      },
      409,
    )
  }

  // Flip the flag, wake the loop's gate. The loop captures the fresh
  // screenshot + injects the synthetic user turn + records the
  // user_takeover/ended step on its side; the route only handles the
  // status flip + SSE emit.
  markTakeoverEnded(runId)
  await updateRunState(runId, { status: 'running' })

  const resumedAt = new Date().toISOString()
  publish(runId, {
    type: 'takeover_ended',
    data: {
      run_id: runId,
      ended_at: resumedAt,
    },
  })

  return c.json(
    {
      status: 'running',
      resumed_at: resumedAt,
    },
    200,
  )
})

const resolveApprovalBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    remember: z.boolean().optional(),
  })
  .strict()

/**
 * POST /v1/runtime/runs/:runId/approvals/:approvalId/resolve — Phase 04B.
 *
 * Workspace JWT required (this whole route group is wrapped in
 * `requireWorkspaceJwt` from app.ts). 404 if the approval does not exist
 * or its run is not owned by the calling workspace. 409 if the approval is
 * already resolved or its `expires_at` deadline has passed.
 *
 * On success: updates the approval row, optionally creates a trust grant
 * (when `remember: true` AND `decision: approve`), signals the in-process
 * waiter so the orchestrator fiber unblocks, and emits `approval_resolved`
 * on the run's SSE channel.
 */
runsRoute.post(
  '/:runId/approvals/:approvalId/resolve',
  zValidator('json', resolveApprovalBodySchema, (result, c) => {
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
    const runId = c.req.param('runId')
    const approvalId = c.req.param('approvalId')
    const body = c.req.valid('json')
    const workspace = c.get('workspace')

    // Authoritative ownership check: the run must belong to the calling
    // workspace. Returning 404 (not 403) on workspace mismatch is intentional
    // — it avoids leaking the existence of approvals scoped to other
    // workspaces. Same posture as the brief's "404 if approval unknown OR
    // run not owned by workspace".
    try {
      await assertWorkspaceMatch(runId, workspace.workspace_id)
    } catch (err) {
      if (
        err instanceof RunNotFoundError ||
        err instanceof RunAccessDeniedError
      ) {
        return c.json({ error: 'approval_not_found' }, 404)
      }
      throw err
    }

    const approval = await getApproval(approvalId)
    if (!approval || approval.runId !== runId) {
      return c.json({ error: 'approval_not_found' }, 404)
    }

    if (approval.status !== 'pending') {
      return c.json(
        {
          error: 'approval_already_resolved',
          status: approval.status,
        },
        409,
      )
    }

    // Expiry check happens before the write so we surface a coherent 409 +
    // flip the row to `timeout` ourselves. The in-memory waiter (if any) has
    // its own setTimeout, so this is just here to keep the DB tidy when the
    // resolve call races the deadline.
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      try {
        await resolveApproval(approvalId, {
          decision: 'timeout',
          resolvedVia: 'system',
        })
        publish(runId, {
          type: 'approval_timeout',
          data: {
            approval_id: approvalId,
            ts: new Date().toISOString(),
          },
        })
      } catch {
        // race lost; ignore — caller still gets 409.
      }
      return c.json({ error: 'approval_expired' }, 409)
    }

    let resolved
    try {
      resolved = await resolveApproval(approvalId, {
        decision: body.decision,
        resolvedBy: workspace.account_id,
        resolvedVia: 'overlay',
        remember: body.remember ?? false,
      })
    } catch (err) {
      if (err instanceof ApprovalNotFoundError) {
        return c.json({ error: 'approval_not_found' }, 404)
      }
      if (err instanceof ApprovalAlreadyResolvedError) {
        return c.json(
          {
            error: 'approval_already_resolved',
            status: err.currentStatus,
          },
          409,
        )
      }
      throw err
    }

    // Optional trust-grant creation. v1 stores a broad workspace-scoped grant
    // ("auto-approve this tool everywhere going forward") so the user-facing
    // semantics match the wording on the overlay button. TODO(Phase 09): UI
    // for narrower grants (per-workflow scope, params constraints, expiry).
    if (body.remember === true && body.decision === 'approve') {
      try {
        await createTrustGrant({
          workspaceId: workspace.workspace_id,
          grantedBy: workspace.account_id,
          actionPattern: resolved.toolName,
          paramsConstraint: {},
          scope: 'workspace',
        })
      } catch (err) {
        // Trust-grant creation is best-effort: a DB error here should not
        // un-resolve the approval the user just clicked. Log and move on.
        logger.warn(
          {
            run_id: runId,
            approval_id: approvalId,
            err: { message: (err as Error).message },
          },
          'trust grant creation failed; approval resolution preserved',
        )
      }
    }

    // Wake the orchestrator fiber blocked on `awaitResolution`. If no
    // waiter exists (e.g. process restart between create + resolve), the
    // DB row is still authoritative — return success either way.
    signalResolution(approvalId, body.decision)

    // SSE notification mirrors the middleware's own emit on the in-process
    // path so the dashboard sees the same event regardless of which side
    // of the race won.
    publish(runId, {
      type: 'approval_resolved',
      data: {
        approval_id: approvalId,
        decision: body.decision,
        resolved_via: 'overlay',
        ts: new Date().toISOString(),
      },
    })

    return c.json(
      {
        status: resolved.status,
        resolved_at: resolved.resolvedAt,
      },
      200,
    )
  },
)

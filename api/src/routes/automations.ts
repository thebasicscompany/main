/**
 * D.2 — Automations CRUD.
 *
 *   POST   /v1/automations               — create
 *   GET    /v1/automations               — list (active)
 *   GET    /v1/automations/:id           — fetch one (404 when archived)
 *   PUT    /v1/automations/:id           — update (snapshot prior + increment version)
 *   DELETE /v1/automations/:id           — soft delete (archived_at)
 *   GET    /v1/automations/:id/versions  — list historical snapshots
 *
 * All routes require workspace JWT (mounted at /v1/automations in app.ts).
 * Workspace scope enforced by `workspace_id` filter on every query.
 *
 * Triggers + outputs are Zod-validated against the schemas in
 * AUTOMATIONS-PLAN §5.3.2 + §2.4. Per-row trigger registration with
 * Composio (D.4) and EventBridge schedules (D.6) hook off the
 * triggers list AFTER create/update lands; this route is data-plane only.
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import {
  reconcileTriggers,
  teardownAllTriggers,
  loadConnectedAccountByToolkit,
  type AnyTrigger,
} from '../lib/automation-trigger-registry.js'
import { pickInputMapper } from '../lib/composio-trigger-router.js'
import { wrapAutomationGoal } from '../lib/cloud-run-dispatch.js'
import { ComposioClient } from '../lib/composio.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

export const automationsRoute = new Hono<{ Variables: Vars }>()

let _sqs: SQSClient | null = null
function sqsClient(): SQSClient {
  if (!_sqs) _sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  return _sqs
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/
const E164_RE = /^\+[1-9]\d{6,14}$/

// J.2 — automation goal wrapping is centralized in
// `api/src/lib/cloud-run-dispatch.ts` (`wrapAutomationGoal`) so the same
// framing applies at every dispatch site (manual, dry-run, draft-from-chat,
// schedule, composio-webhook).

/**
 * J.7 — validate every `composio_webhook` trigger against Composio's
 * actual config schema BEFORE persisting the draft. Previously
 * propose_automation only enforced the structural Zod shape (toolkit +
 * event + filters as object), but accepted any filter shape. Composio
 * would then reject the trigger at activation time, leaving the operator
 * with a status='active' automation whose webhook silently isn't
 * registered. Surfaced 3x in a row on the LP Mapper authoring loop.
 *
 * Returns null when all triggers validate; otherwise an array of
 * structured failures (one per trigger index that fails) the caller
 * surfaces as a 400 to the agent.
 */
interface TriggerValidationFailure {
  triggerIndex: number
  type: 'composio_webhook'
  toolkit: string
  event: string
  reason:
    | 'trigger_type_not_found'
    | 'config_missing_required_field'
    | 'config_field_wrong_type'
    | 'composio_unavailable'
  detail: string
  missingFields?: string[]
}

async function validateComposioWebhookTriggers(
  triggers: AnyTrigger[],
): Promise<TriggerValidationFailure[]> {
  const failures: TriggerValidationFailure[] = []
  const client = new ComposioClient()

  // Memoise per-slug schema fetches in case the same trigger appears
  // multiple times in one spec (rare, but cheap to handle).
  const schemaCache = new Map<
    string,
    Awaited<ReturnType<typeof client.getTriggerType>>['raw']
  >()

  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i]!
    if (t.type !== 'composio_webhook') continue
    const slug = t.event
    let schema: Awaited<ReturnType<typeof client.getTriggerType>>['raw']
    try {
      let cached = schemaCache.get(slug)
      if (cached === undefined) {
        const r = await client.getTriggerType(slug)
        cached = r.raw
        schemaCache.set(slug, cached)
      }
      schema = cached
    } catch (err) {
      logger.warn(
        { slug, err: (err as Error).message },
        'propose_automation: composio getTriggerType threw — flagging as composio_unavailable; agent should retry',
      )
      failures.push({
        triggerIndex: i,
        type: 'composio_webhook',
        toolkit: t.toolkit,
        event: slug,
        reason: 'composio_unavailable',
        detail: `Could not reach Composio to validate trigger schema: ${(err as Error).message}`,
      })
      continue
    }
    if (!schema) {
      failures.push({
        triggerIndex: i,
        type: 'composio_webhook',
        toolkit: t.toolkit,
        event: slug,
        reason: 'trigger_type_not_found',
        detail: `Composio has no trigger type with slug "${slug}". Use the composio_list_triggers tool to discover real slugs.`,
      })
      continue
    }
    const required = schema.config?.required ?? []
    const provided = (t.filters ?? {}) as Record<string, unknown>
    const missing = required.filter((field) => !(field in provided))
    if (missing.length > 0) {
      failures.push({
        triggerIndex: i,
        type: 'composio_webhook',
        toolkit: t.toolkit,
        event: slug,
        reason: 'config_missing_required_field',
        detail: `Trigger "${slug}" requires config fields: ${required.join(', ')}. Missing: ${missing.join(', ')}. Call composio_list_triggers({slug:"${slug}"}) for the full schema.`,
        missingFields: missing,
      })
    }
    // Type-level validation: only flag the obvious cases (string filter
    // value where schema says object, or vice versa). We don't try to
    // fully validate JSON Schema here — Composio enforces deeper validation
    // at activation and that path now rolls back cleanly (J.6).
    const properties = (schema.config?.properties ?? {}) as Record<string, { type?: string }>
    for (const [field, value] of Object.entries(provided)) {
      const expected = properties[field]?.type
      if (!expected) continue
      const actual = Array.isArray(value) ? 'array' : typeof value
      if (
        (expected === 'string' && actual !== 'string') ||
        (expected === 'number' && actual !== 'number') ||
        (expected === 'integer' && actual !== 'number') ||
        (expected === 'boolean' && actual !== 'boolean') ||
        (expected === 'array' && actual !== 'array') ||
        (expected === 'object' && (actual !== 'object' || Array.isArray(value)))
      ) {
        failures.push({
          triggerIndex: i,
          type: 'composio_webhook',
          toolkit: t.toolkit,
          event: slug,
          reason: 'config_field_wrong_type',
          detail: `Trigger "${slug}" config field "${field}" expects type ${expected}, got ${actual}.`,
        })
      }
    }
  }
  return failures
}

// ─── Zod: triggers (§5.3.2) ──────────────────────────────────────────────
const ManualTrigger = z.object({
  type: z.literal('manual'),
})
const RecurringScheduleTrigger = z.object({
  type: z.literal('schedule'),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
})
const OneShotScheduleTrigger = z.object({
  type: z.literal('schedule'),
  at: z.string().datetime(),
})
const ComposioWebhookTrigger = z.object({
  type: z.literal('composio_webhook'),
  toolkit: z.string().min(1).max(64),
  event: z.string().min(1).max(128),
  filters: z.record(z.string(), z.unknown()).optional(),
})
const Trigger = z.union([
  ManualTrigger,
  RecurringScheduleTrigger,
  OneShotScheduleTrigger,
  ComposioWebhookTrigger,
])
const TriggersArray = z.array(Trigger).max(20)

// ─── Zod: outputs (§2.4) ─────────────────────────────────────────────────
const When = z.enum(['on_complete', 'on_failure'])
const SmsOutput = z.object({
  channel: z.literal('sms'),
  to: z.string().regex(E164_RE, 'must be E.164'),
  includeArtifacts: z.boolean().optional(),
  when: When,
})
const EmailOutput = z.object({
  channel: z.literal('email'),
  to: z.string().email(),
  subject: z.string().min(1).max(998).optional(),
  includeArtifacts: z.boolean().optional(),
  when: When,
})
const Output = z.union([SmsOutput, EmailOutput])
const OutputsArray = z.array(Output).max(20)

// ─── Zod: approval_policy (best-effort shape; freeform JSONB ok for v1) ──
const ApprovalPolicy = z
  .object({
    require_for_tools: z.array(z.string()).optional(),
    auto_approve_rules: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .nullable()
  .optional()

// ─── Zod: create / update bodies ─────────────────────────────────────────
// E.8 — `status` is now a first-class field. CREATE defaults to 'draft'
// so newly authored automations don't auto-register Composio triggers /
// EventBridge schedules until the operator explicitly activates them.
// PUT can flip the status (e.g. draft → active during /activate; or back
// to draft to pause). 'archived' is the soft-delete state set by DELETE.
const StatusEnum = z.enum(['draft', 'active', 'archived'])
const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  goal: z.string().min(1).max(64 * 1024),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  outputs: OutputsArray.default([]),
  triggers: TriggersArray.default([{ type: 'manual' }]),
  approval_policy: ApprovalPolicy,
  status: StatusEnum.default('draft'),
})

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  goal: z.string().min(1).max(64 * 1024).optional(),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  outputs: OutputsArray.optional(),
  triggers: TriggersArray.optional(),
  approval_policy: ApprovalPolicy,
  status: StatusEnum.optional(),
}).refine((v) => Object.keys(v).length > 0, 'at least one field required')

// ─── helpers ─────────────────────────────────────────────────────────────

interface AutomationRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  goal: string
  context: unknown
  outputs: unknown
  triggers: unknown
  approval_policy: unknown
  version: number
  status: string
  created_by: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

async function loadAutomation(ws: string, id: string): Promise<AutomationRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, workspace_id, name, description, goal, context, outputs, triggers,
           approval_policy, version, status, created_by,
           created_at::text AS created_at, updated_at::text AS updated_at,
           archived_at::text AS archived_at
      FROM public.automations
     WHERE id = ${id} AND workspace_id = ${ws}
     LIMIT 1
  `)) as unknown as Array<AutomationRow>
  return rows[0] ?? null
}

function publicShape(row: AutomationRow): Record<string, unknown> {
  return row as unknown as Record<string, unknown>
}

// ─── POST /v1/automations ────────────────────────────────────────────────

automationsRoute.post('/', zValidator('json', CreateSchema), async (c) => {
  const ws = c.var.workspace!.workspace_id
  const acc = c.var.workspace!.account_id
  const body = c.req.valid('json')

  const rows = (await db.execute(sql`
    INSERT INTO public.automations
      (workspace_id, name, description, goal, context, outputs, triggers,
       approval_policy, version, status, created_by)
    VALUES
      (${ws}, ${body.name}, ${body.description ?? null}, ${body.goal},
       ${body.context == null ? null : JSON.stringify(body.context)}::jsonb,
       ${JSON.stringify(body.outputs)}::jsonb,
       ${JSON.stringify(body.triggers)}::jsonb,
       ${body.approval_policy == null ? null : JSON.stringify(body.approval_policy)}::jsonb,
       1, ${body.status}, ${acc})
    RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
              approval_policy, version, status, created_by,
              created_at::text AS created_at, updated_at::text AS updated_at,
              archived_at::text AS archived_at
  `)) as unknown as Array<AutomationRow>

  const row = rows[0]!

  // Initial automation_versions snapshot at version 1.
  await db.execute(sql`
    INSERT INTO public.automation_versions (automation_id, version, snapshot_json)
    VALUES (${row.id}, 1, ${JSON.stringify({
      name: row.name,
      description: row.description,
      goal: row.goal,
      context: row.context,
      outputs: row.outputs,
      triggers: row.triggers,
      approval_policy: row.approval_policy,
    })}::jsonb)
  `)

  // D.4 / E.8 — Register triggers (Composio webhooks + EventBridge
  // schedules) ONLY when the row is 'active'. Drafts don't register so
  // they don't fire on schedule or webhook delivery until the operator
  // explicitly /activates them.
  let reg: Awaited<ReturnType<typeof reconcileTriggers>> = { added: [], removed: [], warnings: [] }
  if (row.status === 'active') {
    const connectedAccounts = await loadConnectedAccountByToolkit(ws, c.var.workspace!.account_id)
    const triggers = (row.triggers as unknown as AnyTrigger[]) ?? []
    reg = await reconcileTriggers({
      workspaceId: ws,
      accountId: acc,
      automationId: row.id,
      goal: row.goal,
      priorTriggers: [],
      nextTriggers: triggers,
      // F.10 fix: Composio's connection entity_id is the account_id
      // (per loadConnectedAccountByToolkit's lookup convention), not
      // the workspace_id. Storing workspace_id here as composio_user_id
      // caused the cron-kicker's adapter calls to fail with
      // ConnectedAccountEntityIdMismatch (HTTP 400) because the
      // composio_call payload's user_id didn't match the connection's
      // owning entity.
      composioUserId: acc,
      connectedAccountByToolkit: connectedAccounts,
    })
  }

  return c.json({ automation: publicShape(row), triggerRegistration: reg }, 201)
})

// ─── GET /v1/automations ─────────────────────────────────────────────────

automationsRoute.get('/', zValidator('query', z.object({
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
})), async (c) => {
  const ws = c.var.workspace!.workspace_id
  const q = c.req.valid('query')
  const rows = (await db.execute(sql`
    SELECT id, workspace_id, name, description, goal, context, outputs, triggers,
           approval_policy, version, status, created_by,
           created_at::text AS created_at, updated_at::text AS updated_at,
           archived_at::text AS archived_at
      FROM public.automations
     WHERE workspace_id = ${ws}
       ${q.includeArchived ? sql`` : sql`AND archived_at IS NULL`}
     ORDER BY created_at DESC
     LIMIT ${q.limit}
  `)) as unknown as Array<AutomationRow>
  return c.json({ automations: rows })
})

// ─── GET /v1/automations/:id ─────────────────────────────────────────────

automationsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace!.workspace_id
  const row = await loadAutomation(ws, id)
  if (!row || row.archived_at) return c.json({ error: 'not_found' }, 404)
  return c.json({ automation: publicShape(row) })
})

// ─── PUT /v1/automations/:id ─────────────────────────────────────────────

automationsRoute.put('/:id', zValidator('json', UpdateSchema), async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace!.workspace_id
  const prior = await loadAutomation(ws, id)
  if (!prior || prior.archived_at) return c.json({ error: 'not_found' }, 404)

  const body = c.req.valid('json')

  // 1) Snapshot the PRIOR state into automation_versions (current version
  //    number, so v1 → snapshot v1; the post-update row becomes v2).
  //    This preserves the "what was active before the edit" record.
  await db.execute(sql`
    INSERT INTO public.automation_versions (automation_id, version, snapshot_json)
    VALUES (${id}, ${prior.version}, ${JSON.stringify({
      name: prior.name,
      description: prior.description,
      goal: prior.goal,
      context: prior.context,
      outputs: prior.outputs,
      triggers: prior.triggers,
      approval_policy: prior.approval_policy,
    })}::jsonb)
    ON CONFLICT (automation_id, version) DO NOTHING
  `)

  // 2) Apply the patch. Only fields present in `body` are touched.
  const newName        = body.name        ?? prior.name
  const newDescription = body.description !== undefined ? body.description : prior.description
  const newGoal        = body.goal        ?? prior.goal
  const newContext     = body.context     !== undefined ? body.context     : prior.context
  const newOutputs     = body.outputs     ?? prior.outputs
  const newTriggers    = body.triggers    ?? prior.triggers
  const newPolicy      = body.approval_policy !== undefined ? body.approval_policy : prior.approval_policy
  const newStatus      = body.status       ?? prior.status

  const rows = (await db.execute(sql`
    UPDATE public.automations
       SET name            = ${newName},
           description     = ${newDescription},
           goal            = ${newGoal},
           context         = ${newContext == null ? null : JSON.stringify(newContext)}::jsonb,
           outputs         = ${JSON.stringify(newOutputs)}::jsonb,
           triggers        = ${JSON.stringify(newTriggers)}::jsonb,
           approval_policy = ${newPolicy == null ? null : JSON.stringify(newPolicy)}::jsonb,
           status          = ${newStatus},
           version         = ${prior.version + 1},
           updated_at      = now()
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
               approval_policy, version, status, created_by,
               created_at::text AS created_at, updated_at::text AS updated_at,
               archived_at::text AS archived_at
  `)) as unknown as Array<AutomationRow>

  // D.4 / E.8 — Reconcile triggers ONLY when the row is (now) active.
  // Drafts never have registered triggers; active → draft tears them
  // down; draft → draft is a no-op for registration.
  const updated = rows[0]!
  let reg: Awaited<ReturnType<typeof reconcileTriggers>> = { added: [], removed: [], warnings: [] }
  if (updated.status === 'active') {
    const connectedAccounts = await loadConnectedAccountByToolkit(ws, c.var.workspace!.account_id)
    reg = await reconcileTriggers({
      workspaceId: ws,
      accountId: c.var.workspace!.account_id,
      automationId: updated.id,
      goal: updated.goal,
      priorTriggers: prior.status === 'active'
        ? ((prior.triggers as unknown as AnyTrigger[]) ?? [])
        : [],
      nextTriggers: (updated.triggers as unknown as AnyTrigger[]) ?? [],
      composioUserId: c.var.workspace!.account_id,
      connectedAccountByToolkit: connectedAccounts,
    })
  } else if (prior.status === 'active') {
    reg = await teardownAllTriggers(
      updated.id,
      (prior.triggers as unknown as AnyTrigger[]) ?? [],
    )
  }

  // Migration 0024 — invalidate any per-automation approval_rules when
  // the automation is edited. The rule's args_pattern came from the prior
  // version's args; once the operator changes the goal/outputs/triggers
  // the standing approval becomes a stale safety hazard. Operator can
  // re-grant via "YES ALWAYS" on the next gated call.
  const droppedRules = (await db.execute(sql`
    DELETE FROM public.approval_rules
     WHERE automation_id = ${updated.id}
     RETURNING id
  `)) as unknown as Array<{ id: string }>

  return c.json({
    automation: publicShape(updated),
    triggerRegistration: reg,
    approvalRulesInvalidated: droppedRules.length,
  })
})

// ─── DELETE /v1/automations/:id ──────────────────────────────────────────

automationsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace!.workspace_id
  const prior = await loadAutomation(ws, id)
  if (!prior) return c.json({ error: 'not_found' }, 404)
  if (prior.archived_at) {
    // Already archived — idempotent.
    return c.json({ id, archived_at: prior.archived_at, idempotent: true })
  }
  const rows = (await db.execute(sql`
    UPDATE public.automations
       SET archived_at = now(), updated_at = now(), status = 'archived'
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING archived_at::text AS archived_at
  `)) as unknown as Array<{ archived_at: string }>

  // D.4 — Tear down all registered triggers (only meaningful when the
  // automation was active — drafts never registered any).
  const teardown = prior.status === 'active'
    ? await teardownAllTriggers(id, (prior.triggers as unknown as AnyTrigger[]) ?? [])
    : { added: [], removed: [], warnings: [] }

  return c.json({ id, archived_at: rows[0]!.archived_at, triggerTeardown: teardown })
})

// ─── GET /v1/automations/:id/versions ────────────────────────────────────

automationsRoute.get('/:id/versions', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace!.workspace_id

  // Confirm the automation belongs to this workspace (even if archived —
  // historical version listing is allowed for archived rows).
  const owner = (await db.execute(sql`
    SELECT id FROM public.automations
     WHERE id = ${id} AND workspace_id = ${ws}
     LIMIT 1
  `)) as unknown as Array<{ id: string }>
  if (owner.length === 0) return c.json({ error: 'not_found' }, 404)

  const rows = (await db.execute(sql`
    SELECT id, automation_id, version, snapshot_json, created_at::text AS created_at
      FROM public.automation_versions
     WHERE automation_id = ${id}
     ORDER BY version ASC
  `)) as unknown as Array<Record<string, unknown>>

  return c.json({ versions: rows })
})

// ─── POST /v1/automations/:id/run  (D.3 manual trigger) ─────────────────

const RunSchema = z.object({
  inputs: z.record(z.string(), z.unknown()).optional(),
})

/**
 * D.3 — Manually trigger an automation.
 *
 * Behavior:
 *   1) Look up the automation; 404 if missing or archived.
 *   2) Resolve a cloud_agent_id for this run. Re-uses an `ad-hoc` agent
 *      per workspace (created on first manual trigger) so the existing
 *      cloud_runs.cloud_agent_id NOT NULL constraint is satisfied
 *      without coupling automations to cloud_agents.
 *   3) Insert cloud_runs row with automation_id, automation_version,
 *      triggered_by='manual', inputs (or {}), status='pending'.
 *   4) Publish to basics-runs.fifo SQS with workspace_id as
 *      MessageGroupId (per §D.3) so the dispatcher Lambda picks it up
 *      the same way as POST /v1/runs.
 *
 * Returns { runId, status: 'pending', automation_version, triggered_by }.
 */
automationsRoute.post(
  '/:id/run',
  zValidator('json', RunSchema),
  async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)

    const ws = c.var.workspace!.workspace_id
    const acc = c.var.workspace!.account_id
    const body = c.req.valid('json')
    const inputs = body.inputs ?? {}

    const automation = await loadAutomation(ws, id)
    if (!automation || automation.archived_at) {
      return c.json({ error: 'not_found' }, 404)
    }

    // (2) Ad-hoc cloud_agent reuse — same lookup-or-create pattern as
    // cloud-runs.ts so the dispatcher's existing query plan keeps working.
    let cloudAgentId: string
    const existing = (await db.execute(sql`
      SELECT id FROM public.cloud_agents
       WHERE workspace_id = ${ws} AND agent_id = 'ad-hoc'
       LIMIT 1
    `)) as unknown as Array<{ id: string }>
    if (existing[0]) {
      cloudAgentId = existing[0].id
    } else {
      const created = (await db.execute(sql`
        INSERT INTO public.cloud_agents
          (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
        VALUES
          (${ws}, ${acc}, 'ad-hoc', 'Manual + automation-triggered runs',
           'manual', 'active', ${ws}, 'harness')
        RETURNING id
      `)) as unknown as Array<{ id: string }>
      cloudAgentId = created[0]!.id
    }

    // (3) Insert cloud_runs row.
    const runId = randomUUID()
    await db.execute(sql`
      INSERT INTO public.cloud_runs
        (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
         automation_id, automation_version, triggered_by, inputs)
      VALUES
        (${runId}, ${cloudAgentId}, ${ws}, ${acc}, 'pending', 'live',
         ${automation.id}, ${automation.version}, 'manual',
         ${JSON.stringify(inputs)}::jsonb)
    `)

    // (4) Dispatch via SQS — same payload shape as POST /v1/runs so the
    // dispatcher Lambda needs no changes. We pull the goal from the
    // automation; inputs ride along so the worker can stash them.
    const cfg = getConfig()
    const queueUrl = cfg.RUNS_QUEUE_URL
    if (!queueUrl) {
      return c.json({ error: 'runs_queue_not_configured' }, 503)
    }
    // J.2 — wrap goal so the agent EXECUTES the pipeline against the
    // trigger payload, instead of treating the spec text as an authoring
    // request (which surfaced on the LP-mapping live test as recursive
    // propose_automation and "lecture about tool limitations" outcomes).
    const wrappedGoal = wrapAutomationGoal(
      automation.name,
      automation.goal,
      inputs,
      'live',
      'manual',
    )
    await sqsClient().send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        runId,
        workspaceId: ws,
        accountId: acc,
        goal: wrappedGoal,
        automationId: automation.id,
        automationVersion: automation.version,
        triggeredBy: 'manual',
        inputs,
      }),
      MessageGroupId: ws,
      MessageDeduplicationId: runId,
    }))

    return c.json({
      runId,
      status: 'pending',
      automationId: automation.id,
      automationVersion: automation.version,
      triggeredBy: 'manual',
    }, 202)
  },
)

// ─── POST /v1/automations/:id/dry-run  (E.8) ─────────────────────────────

const E8DryRunSchema = z.object({
  inputs: z.record(z.string(), z.unknown()).optional(),
  triggerIndex: z.number().int().min(0).optional(),
  synthetic_payload: z.record(z.string(), z.unknown()).optional(),
})

/**
 * E.8 — dispatch a DRY RUN of an automation. The worker boots normally,
 * reads the agent's goal, executes read-only tools (browser, list calls,
 * screenshots), but the E.7 interceptor quarantines every mutating
 * outbound tool call (send_email, send_sms, mutating composio_call) into
 * `cloud_runs.dry_run_actions` instead of executing it.
 *
 * Available on automations in ANY status — drafts (so the operator can
 * preview before activating) AND active rows (so they can sanity-check
 * before triggering a real run).
 *
 * Body:
 *   - inputs?            Object passed verbatim to the worker as RunInputs.
 *   - triggerIndex?      If set, builds inputs from the trigger's
 *                         input-mapper applied to `synthetic_payload`
 *                         (or that trigger's canned default).
 *   - synthetic_payload? Only used when triggerIndex is set.
 *
 * Returns { runId, status:'pending', dryRun:true, automationVersion,
 *           triggeredBy:'dry_run', previewPollUrl }.
 */
automationsRoute.post(
  '/:id/dry-run',
  zValidator('json', E8DryRunSchema.optional().default({})),
  async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)

    const ws = c.var.workspace!.workspace_id
    const acc = c.var.workspace!.account_id
    const body = c.req.valid('json')

    const automation = await loadAutomation(ws, id)
    if (!automation || automation.archived_at) {
      return c.json({ error: 'not_found' }, 404)
    }

    let inputs: Record<string, unknown> = body.inputs ?? {}
    if (body.triggerIndex !== undefined) {
      const triggers = (automation.triggers as unknown as AnyTrigger[]) ?? []
      const trigger = triggers[body.triggerIndex]
      if (!trigger) {
        return c.json({ error: 'trigger_index_out_of_range', max: triggers.length - 1 }, 404)
      }
      const payload = body.synthetic_payload ?? cannedDefaultPayload(trigger)
      if (trigger.type === 'composio_webhook') {
        inputs = pickInputMapper(trigger.toolkit, trigger.event)(payload)
      } else {
        inputs = {}
      }
    }

    // Resolve / lazy-create the ad-hoc cloud_agent (same pattern as
    // POST /:id/run from D.3).
    let cloudAgentId: string
    const existing = (await db.execute(sql`
      SELECT id FROM public.cloud_agents
       WHERE workspace_id = ${ws} AND agent_id = 'ad-hoc'
       LIMIT 1
    `)) as unknown as Array<{ id: string }>
    if (existing[0]) {
      cloudAgentId = existing[0].id
    } else {
      const created = (await db.execute(sql`
        INSERT INTO public.cloud_agents
          (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
        VALUES
          (${ws}, ${acc}, 'ad-hoc', 'Manual + automation-triggered runs',
           'manual', 'active', ${ws}, 'harness')
        RETURNING id
      `)) as unknown as Array<{ id: string }>
      cloudAgentId = created[0]!.id
    }

    const runId = randomUUID()
    await db.execute(sql`
      INSERT INTO public.cloud_runs
        (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
         automation_id, automation_version, triggered_by, inputs,
         dry_run, dry_run_actions)
      VALUES
        (${runId}, ${cloudAgentId}, ${ws}, ${acc}, 'pending', 'test',
         ${automation.id}, ${automation.version}, 'dry_run',
         ${JSON.stringify(inputs)}::jsonb, true, '[]'::jsonb)
    `)

    const cfg = getConfig()
    const queueUrl = cfg.RUNS_QUEUE_URL
    if (!queueUrl) {
      return c.json({ error: 'runs_queue_not_configured' }, 503)
    }
    // J.2 — wrap the goal for the dry-run worker (single-pass execution
    // framing). Same fix that landed in /draft-from-chat.
    const wrappedGoal = wrapAutomationGoal(automation.name, automation.goal, inputs, 'dry', 'dry_run')
    await sqsClient().send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        runId,
        workspaceId: ws,
        accountId: acc,
        goal: wrappedGoal,
        automationId: automation.id,
        automationVersion: automation.version,
        triggeredBy: 'dry_run',
        inputs,
        dryRun: true,
      }),
      MessageGroupId: ws,
      MessageDeduplicationId: runId,
    }))

    return c.json({
      runId,
      status: 'pending',
      dryRun: true,
      automationId: automation.id,
      automationVersion: automation.version,
      triggeredBy: 'dry_run',
      previewPollUrl: `/v1/runs/${runId}/dry-run-preview`,
    }, 202)
  },
)

// ─── POST /v1/automations/:id/activate  (E.8) ────────────────────────────
//
// Flip a draft → active, registering Composio webhook subscriptions +
// EventBridge schedules. Idempotent on already-active rows: returns the
// row unchanged with `alreadyActive:true`. Archived rows reject with 409.

/**
 * J.6 — strict-by-default activation.
 *
 * Body (all optional):
 *   - acceptFailedTriggers?: boolean  — explicit "activate even if some
 *     triggers fail to register" override. Default false. Without this,
 *     ANY trigger registration failure rolls the automation back to
 *     `draft` and returns 422 with the failures structured for the
 *     caller (agent or operator) to fix.
 *
 * Pre-J.6 the route flipped status='active' first, then attempted
 * trigger registration, and surfaced failures only as warnings. The
 * operator hit this 3 rounds in a row on the LP Mapper authoring loop:
 * activate returned ok:true and status=active, but the Composio
 * webhook silently didn't register, so adding a row never fired anything.
 */
const ActivateSchema = z.object({
  acceptFailedTriggers: z.boolean().optional(),
})

automationsRoute.post(
  '/:id/activate',
  zValidator('json', ActivateSchema.optional().default({})),
  async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
    const ws = c.var.workspace!.workspace_id
    const acc = c.var.workspace!.account_id
    const body = c.req.valid('json') as { acceptFailedTriggers?: boolean }

    const prior = await loadAutomation(ws, id)
    if (!prior || prior.archived_at) return c.json({ error: 'not_found' }, 404)
    if (prior.status === 'archived') return c.json({ error: 'cannot_activate_archived' }, 409)
    if (prior.status === 'active') {
      return c.json({ automation: publicShape(prior), alreadyActive: true })
    }

    // J.6 — register triggers BEFORE flipping status. If any fail and the
    // caller didn't pass acceptFailedTriggers:true, leave the automation
    // in draft and return a structured error.
    const connectedAccounts = await loadConnectedAccountByToolkit(ws, acc)
    const reg = await reconcileTriggers({
      workspaceId: ws,
      accountId: acc,
      automationId: prior.id,
      goal: prior.goal,
      priorTriggers: [],
      nextTriggers: (prior.triggers as unknown as AnyTrigger[]) ?? [],
      composioUserId: acc,
      connectedAccountByToolkit: connectedAccounts,
    })

    const hasFailures = reg.warnings.length > 0
    if (hasFailures && body.acceptFailedTriggers !== true) {
      // Tear down anything we DID manage to register so we leave a clean
      // draft state (no half-registered Composio subscriptions or
      // schedules drifting from the automation's status='draft').
      try {
        await teardownAllTriggers(
          prior.id,
          (prior.triggers as unknown as AnyTrigger[]) ?? [],
        )
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, automationId: prior.id },
          'activate (strict mode): teardown after partial registration failed; some triggers may still be live',
        )
      }
      return c.json(
        {
          error: 'trigger_registration_failed',
          message:
            'One or more triggers failed to register with Composio / EventBridge. Automation kept in DRAFT status. Fix the trigger config and retry, or pass {acceptFailedTriggers:true} to activate anyway (only the working triggers will be live).',
          failures: reg.warnings,
          registered: reg.added,
        },
        422,
      )
    }

    const rows = (await db.execute(sql`
      UPDATE public.automations
         SET status = 'active', updated_at = now()
       WHERE id = ${id} AND workspace_id = ${ws}
       RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
                 approval_policy, version, status, created_by,
                 created_at::text AS created_at, updated_at::text AS updated_at,
                 archived_at::text AS archived_at
    `)) as unknown as Array<AutomationRow>
    const updated = rows[0]!

    return c.json({
      automation: publicShape(updated),
      triggerRegistration: reg,
      // Truthy only when the caller explicitly opted into partial activation.
      ...(hasFailures ? { partialActivation: true, failuresAccepted: reg.warnings } : {}),
    })
  },
)

// ─── POST /v1/automations/:id/triggers/:trigger_index/test  (D.8 dry-run) ─

const DryRunSchema = z.object({
  synthetic_payload: z.record(z.string(), z.unknown()).optional(),
})

/** Canned default payloads per trigger type / toolkit + event. */
function cannedDefaultPayload(trigger: AnyTrigger): Record<string, unknown> {
  if (trigger.type === 'composio_webhook') {
    const tk = trigger.toolkit?.toLowerCase()
    const ev = trigger.event?.toUpperCase() ?? ''
    if (tk === 'gmail' && ev.startsWith('GMAIL_')) {
      return {
        messageId: 'msg_dryrun_example',
        threadId: 'thread_dryrun_example',
        subject: 'Sample inbound message',
        from: 'sender@example.com',
        snippet: 'This is a dry-run synthetic email payload.',
        labelIds: ['INBOX', 'UNREAD'],
      }
    }
    if (tk === 'googlesheets' || tk === 'google_sheets') {
      return {
        row: {
          Name: 'Acme Capital',
          Stage: 'New Pipeline',
          'LinkedIn URL': 'https://linkedin.com/company/acme-capital',
        },
        rowNumber: 42,
        spreadsheetId: 'sheet_dryrun_example',
        sheetName: 'LP_Pipeline',
      }
    }
    return { event: { type: trigger.event, toolkit: trigger.toolkit } }
  }
  return {}
}

/**
 * Returns the RunInputs the worker WOULD see if this trigger fired now,
 * without spawning a run or producing any SQS message. Useful for users
 * to debug their automation's trigger wiring.
 */
automationsRoute.post(
  '/:id/triggers/:trigger_index/test',
  zValidator('json', DryRunSchema),
  async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
    const triggerIndexStr = c.req.param('trigger_index')
    const triggerIndex = Number(triggerIndexStr)
    if (!Number.isInteger(triggerIndex) || triggerIndex < 0) {
      return c.json({ error: 'invalid_trigger_index' }, 400)
    }

    const ws = c.var.workspace!.workspace_id
    const automation = await loadAutomation(ws, id)
    if (!automation || automation.archived_at) {
      return c.json({ error: 'not_found' }, 404)
    }

    const triggers = (automation.triggers as unknown as AnyTrigger[]) ?? []
    const trigger = triggers[triggerIndex]
    if (!trigger) {
      return c.json({
        error: 'trigger_index_out_of_range',
        max: triggers.length - 1,
      }, 404)
    }

    const body = c.req.valid('json')
    const payload = body.synthetic_payload ?? cannedDefaultPayload(trigger)

    let inputs: Record<string, unknown>
    if (trigger.type === 'composio_webhook') {
      inputs = pickInputMapper(trigger.toolkit, trigger.event)(payload)
    } else {
      // schedule + manual: no event payload mapping; inputs are empty.
      inputs = {}
    }

    return c.json({
      automationId: automation.id,
      triggerIndex,
      trigger,
      synthetic_payload: payload,
      inputs,
      dispatched: false,
    })
  },
)

// ─── POST /v1/workspaces/:wsId/automations/draft-from-chat  (E.9) ───────
//
// Authoring-side bridge for the chat agent. The worker's
// `propose_automation` tool POSTs here with a draft spec; we CREATE
// (or PUT if an existing draftId is supplied), then immediately fire
// a dry-run so the operator can preview what the automation WOULD do
// before they /activate it. Mounted under /v1/workspaces so the
// existing /v1/workspaces/* requireWorkspaceJwt middleware covers it.

export const draftFromChatRoute = new Hono<{ Variables: Vars }>()

const DraftFromChatSchema = z.object({
  /** When provided AND owned by this workspace, the draft is PUT-updated
   *  instead of CREATEd. Lets iterative chat sessions refine the same row. */
  draftId: z.string().uuid().optional(),
  /** Opaque tag — the calling chat session's id. Stored on the auto-fired
   *  dry-run's inputs so the operator can correlate previews to the chat. */
  sessionId: z.string().min(1).max(200).optional(),
  /** I.1 — opencode `provider/model` override for the dry-run worker
   *  invocation. The authoring chat uses Opus 4.7 for architecture-heavy
   *  decisions; the runtime worker defaults to Sonnet. */
  model: z.string().min(1).max(120).optional(),
  /** Subset of CreateSchema. We force status='draft' regardless of what
   *  the caller sends; activation is a separate step. */
  draft: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    goal: z.string().min(1).max(64 * 1024),
    context: z.record(z.string(), z.unknown()).nullable().optional(),
    outputs: OutputsArray.optional(),
    triggers: TriggersArray.optional(),
    approval_policy: ApprovalPolicy,
  }),
})

draftFromChatRoute.post('/:wsId/automations/draft-from-chat',
  zValidator('json', DraftFromChatSchema),
  async (c) => {
    const pathWs = c.req.param('wsId')
    const ws = c.var.workspace!.workspace_id
    const acc = c.var.workspace!.account_id
    if (!UUID_RE.test(pathWs)) return c.json({ error: 'invalid_workspace_id' }, 400)
    if (pathWs !== ws) return c.json({ error: 'forbidden' }, 403)

    const body = c.req.valid('json')
    const draft = body.draft

    // J.7 — pre-validate composio_webhook trigger configs against
    // Composio's actual schema. Catches "wrong slug" / "missing required
    // config field" at PROPOSE time instead of silently registering a
    // broken webhook at activate time. The agent gets a structured error
    // that tells it which trigger index failed and what's missing.
    if (draft.triggers && draft.triggers.length > 0) {
      const failures = await validateComposioWebhookTriggers(
        draft.triggers as unknown as AnyTrigger[],
      )
      if (failures.length > 0) {
        return c.json(
          {
            error: 'trigger_config_invalid',
            message: 'One or more composio_webhook triggers failed schema validation. Use the composio_list_triggers worker tool to discover real trigger slugs and their required config fields, then re-call propose_automation.',
            failures,
          },
          400,
        )
      }
    }

    let automation: AutomationRow
    if (body.draftId) {
      const prior = await loadAutomation(ws, body.draftId)
      if (!prior || prior.archived_at) {
        return c.json({ error: 'draft_not_found' }, 404)
      }
      // Refuse to overwrite an already-active automation via the chat
      // bridge — that's the operator's call via /activate or the
      // dashboard, not the agent's.
      if (prior.status !== 'draft') {
        return c.json({ error: 'not_a_draft', status: prior.status }, 409)
      }
      // Snapshot the prior row before overwrite (same pattern as PUT).
      await db.execute(sql`
        INSERT INTO public.automation_versions (automation_id, version, snapshot_json)
        VALUES (${prior.id}, ${prior.version}, ${JSON.stringify({
          name: prior.name, description: prior.description, goal: prior.goal,
          context: prior.context, outputs: prior.outputs, triggers: prior.triggers,
          approval_policy: prior.approval_policy,
        })}::jsonb)
        ON CONFLICT (automation_id, version) DO NOTHING
      `)
      const rows = (await db.execute(sql`
        UPDATE public.automations
           SET name            = ${draft.name},
               description     = ${draft.description ?? prior.description},
               goal            = ${draft.goal},
               context         = ${draft.context == null ? null : JSON.stringify(draft.context)}::jsonb,
               outputs         = ${JSON.stringify(draft.outputs ?? prior.outputs ?? [])}::jsonb,
               triggers        = ${JSON.stringify(draft.triggers ?? prior.triggers ?? [{ type: 'manual' }])}::jsonb,
               approval_policy = ${draft.approval_policy == null ? null : JSON.stringify(draft.approval_policy)}::jsonb,
               status          = 'draft',
               version         = ${prior.version + 1},
               updated_at      = now()
         WHERE id = ${prior.id} AND workspace_id = ${ws}
         RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
                   approval_policy, version, status, created_by,
                   created_at::text AS created_at, updated_at::text AS updated_at,
                   archived_at::text AS archived_at
      `)) as unknown as Array<AutomationRow>
      automation = rows[0]!
    } else {
      const rows = (await db.execute(sql`
        INSERT INTO public.automations
          (workspace_id, name, description, goal, context, outputs, triggers,
           approval_policy, version, status, created_by)
        VALUES
          (${ws}, ${draft.name}, ${draft.description ?? null}, ${draft.goal},
           ${draft.context == null ? null : JSON.stringify(draft.context)}::jsonb,
           ${JSON.stringify(draft.outputs ?? [])}::jsonb,
           ${JSON.stringify(draft.triggers ?? [{ type: 'manual' }])}::jsonb,
           ${draft.approval_policy == null ? null : JSON.stringify(draft.approval_policy)}::jsonb,
           1, 'draft', ${acc})
        RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
                  approval_policy, version, status, created_by,
                  created_at::text AS created_at, updated_at::text AS updated_at,
                  archived_at::text AS archived_at
      `)) as unknown as Array<AutomationRow>
      automation = rows[0]!
      // Initial version snapshot.
      await db.execute(sql`
        INSERT INTO public.automation_versions (automation_id, version, snapshot_json)
        VALUES (${automation.id}, 1, ${JSON.stringify({
          name: automation.name, description: automation.description, goal: automation.goal,
          context: automation.context, outputs: automation.outputs, triggers: automation.triggers,
          approval_policy: automation.approval_policy,
        })}::jsonb)
      `)
    }

    // Auto-fire a dry-run: build inputs from the FIRST trigger's canned
    // default; manual / schedule fall back to {}. The chat session id
    // (when supplied) rides along in inputs so the preview UI can
    // correlate the run to the chat.
    const triggers = (automation.triggers as unknown as AnyTrigger[]) ?? []
    let dryInputs: Record<string, unknown> = {}
    const firstTrigger = triggers[0]
    if (firstTrigger && firstTrigger.type === 'composio_webhook') {
      const payload = cannedDefaultPayload(firstTrigger)
      dryInputs = pickInputMapper(firstTrigger.toolkit, firstTrigger.event)(payload)
    }
    if (body.sessionId) dryInputs._draftFromChatSessionId = body.sessionId

    // Reuse the same cloud_agent + dispatch path the /dry-run endpoint uses.
    let cloudAgentId: string
    const existing = (await db.execute(sql`
      SELECT id FROM public.cloud_agents
       WHERE workspace_id = ${ws} AND agent_id = 'ad-hoc'
       LIMIT 1
    `)) as unknown as Array<{ id: string }>
    if (existing[0]) {
      cloudAgentId = existing[0].id
    } else {
      const created = (await db.execute(sql`
        INSERT INTO public.cloud_agents
          (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
        VALUES
          (${ws}, ${acc}, 'ad-hoc', 'Manual + automation-triggered runs',
           'manual', 'active', ${ws}, 'harness')
        RETURNING id
      `)) as unknown as Array<{ id: string }>
      cloudAgentId = created[0]!.id
    }
    const runId = randomUUID()
    await db.execute(sql`
      INSERT INTO public.cloud_runs
        (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
         automation_id, automation_version, triggered_by, inputs,
         dry_run, dry_run_actions)
      VALUES
        (${runId}, ${cloudAgentId}, ${ws}, ${acc}, 'pending', 'test',
         ${automation.id}, ${automation.version}, 'dry_run',
         ${JSON.stringify(dryInputs)}::jsonb, true, '[]'::jsonb)
    `)
    const cfg = getConfig()
    const queueUrl = cfg.RUNS_QUEUE_URL
    if (queueUrl) {
      // J.2 — wrap the goal so the dry-run agent executes the pipeline
      // once instead of recursively re-proposing the automation.
      const wrappedGoal = wrapAutomationGoal(automation.name, automation.goal, dryInputs, 'dry', 'dry_run')
      await sqsClient().send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          runId, workspaceId: ws, accountId: acc, goal: wrappedGoal,
          automationId: automation.id, automationVersion: automation.version,
          triggeredBy: 'dry_run', inputs: dryInputs, dryRun: true,
          ...(body.model ? { model: body.model } : {}),
        }),
        MessageGroupId: ws,
        MessageDeduplicationId: runId,
      }))
    }

    return c.json({
      automationId: automation.id,
      automationVersion: automation.version,
      draftRunId: runId,
      previewPollUrl: `/v1/runs/${runId}/dry-run-preview`,
      automation: publicShape(automation),
    }, body.draftId ? 200 : 201)
  },
)

// ─── GET /v1/runs/:runId/dry-run-preview  (E.8) ──────────────────────────
//
// Mounted at /v1/runs (not /v1/automations) so the URL composes with the
// existing /v1/runs/* JWT middleware in app.ts. Exposed as a separate
// `dryRunPreviewRoute` to keep app.ts mounting symmetric with the rest
// of the runs-namespace routes (cloudRuns, runApprovals).

export const dryRunPreviewRoute = new Hono<{ Variables: Vars }>()

dryRunPreviewRoute.get('/:runId/dry-run-preview', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) return c.json({ error: 'invalid_run_id' }, 400)
  const ws = c.var.workspace!.workspace_id

  const runRows = (await db.execute(sql`
    SELECT id, status, dry_run, dry_run_actions, automation_id, automation_version,
           triggered_by, started_at::text AS started_at,
           completed_at::text AS completed_at
      FROM public.cloud_runs
     WHERE id = ${runId} AND workspace_id = ${ws}
     LIMIT 1
  `)) as unknown as Array<{
    id: string
    status: string
    dry_run: boolean
    dry_run_actions: unknown
    automation_id: string | null
    automation_version: number | null
    triggered_by: string | null
    started_at: string | null
    completed_at: string | null
  }>
  const run = runRows[0]
  if (!run) return c.json({ error: 'not_found' }, 404)
  if (!run.dry_run) return c.json({ error: 'not_a_dry_run' }, 404)

  // Surface a compact activity stream for the UI to render the preview.
  // Excludes per-tool screenshot blob payloads (too heavy for a preview)
  // and tool_call_start/end pairs that don't carry user-facing info.
  const activity = (await db.execute(sql`
    SELECT activity_type, payload, created_at::text AS created_at
      FROM public.cloud_activity
     WHERE agent_run_id = ${runId}
       AND activity_type IN (
         'run_started','dry_run_action','dry_run_summary',
         'final_answer','run_completed',
         'browser_login_required','browser_session_expired',
         'connection_expired','external_action',
         'screenshot'
       )
     ORDER BY created_at ASC
  `)) as unknown as Array<{ activity_type: string; payload: unknown; created_at: string }>

  return c.json({
    runId: run.id,
    status: run.status,
    automationId: run.automation_id,
    automationVersion: run.automation_version,
    triggeredBy: run.triggered_by,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    dryRunActions: run.dry_run_actions,
    activity,
  })
})

// Test-only exports.
export const _internals = { CreateSchema, UpdateSchema, TriggersArray, OutputsArray, RunSchema, cannedDefaultPayload }

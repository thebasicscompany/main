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
const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  goal: z.string().min(1).max(64 * 1024),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  outputs: OutputsArray.default([]),
  triggers: TriggersArray.default([{ type: 'manual' }]),
  approval_policy: ApprovalPolicy,
})

// PUT body is the same shape but every field optional; we apply only the
// supplied ones. Version bump always fires (the spec mandates it).
const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  goal: z.string().min(1).max(64 * 1024).optional(),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  outputs: OutputsArray.optional(),
  triggers: TriggersArray.optional(),
  approval_policy: ApprovalPolicy,
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
  created_by: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

async function loadAutomation(ws: string, id: string): Promise<AutomationRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, workspace_id, name, description, goal, context, outputs, triggers,
           approval_policy, version, created_by,
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
       approval_policy, version, created_by)
    VALUES
      (${ws}, ${body.name}, ${body.description ?? null}, ${body.goal},
       ${body.context == null ? null : JSON.stringify(body.context)}::jsonb,
       ${JSON.stringify(body.outputs)}::jsonb,
       ${JSON.stringify(body.triggers)}::jsonb,
       ${body.approval_policy == null ? null : JSON.stringify(body.approval_policy)}::jsonb,
       1, ${acc})
    RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
              approval_policy, version, created_by,
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

  return c.json({ automation: publicShape(row) }, 201)
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
           approval_policy, version, created_by,
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

  const rows = (await db.execute(sql`
    UPDATE public.automations
       SET name            = ${newName},
           description     = ${newDescription},
           goal            = ${newGoal},
           context         = ${newContext == null ? null : JSON.stringify(newContext)}::jsonb,
           outputs         = ${JSON.stringify(newOutputs)}::jsonb,
           triggers        = ${JSON.stringify(newTriggers)}::jsonb,
           approval_policy = ${newPolicy == null ? null : JSON.stringify(newPolicy)}::jsonb,
           version         = ${prior.version + 1},
           updated_at      = now()
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING id, workspace_id, name, description, goal, context, outputs, triggers,
               approval_policy, version, created_by,
               created_at::text AS created_at, updated_at::text AS updated_at,
               archived_at::text AS archived_at
  `)) as unknown as Array<AutomationRow>

  return c.json({ automation: publicShape(rows[0]!) })
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
       SET archived_at = now(), updated_at = now()
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING archived_at::text AS archived_at
  `)) as unknown as Array<{ archived_at: string }>
  return c.json({ id, archived_at: rows[0]!.archived_at })
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
    await sqsClient().send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        runId,
        workspaceId: ws,
        accountId: acc,
        goal: automation.goal,
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

// Test-only exports.
export const _internals = { CreateSchema, UpdateSchema, TriggersArray, OutputsArray, RunSchema }

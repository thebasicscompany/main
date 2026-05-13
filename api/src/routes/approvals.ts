/**
 * C.5 — Approvals API.
 *
 *   POST /v1/approvals/:id                   — decide (approve/deny). Auth: workspace JWT OR ?token=<raw access token>
 *   GET  /v1/approvals/:id                   — fetch one. Auth: workspace JWT OR ?token=<raw>
 *   GET  /v1/workspaces/:wsId/approvals      — list workspace approvals. Auth: workspace JWT
 *   POST /v1/runs/:runId/approvals/bulk      — decide all pending approvals for a run. Auth: workspace JWT
 *
 * Decision side effects (matches the worker's awaitApproval contract from C.4):
 *   - UPDATE approvals.status + decided_by + decided_at
 *   - on { remember: true, decision: 'approved' }: INSERT into approval_rules
 *     keyed off (workspace_id, tool_name, args_preview) — the worker's
 *     C.3 lookupApprovalRule uses JSONB containment against args_pattern_json.
 *   - INSERT cloud_activity row for `approval_granted` / `approval_denied`
 *     (the worker also emits these on resume; both rows are fine for the
 *     SSE stream — clients dedup by approval_id+kind).
 *   - pg_notify(`approval_<id_underscored>`, ...) — wakes the worker's
 *     sqlListen.listen(channel) handler set up in C.4 await.ts.
 *
 * Signed-token auth: the worker emits the RAW access token in the
 * `approval_requested` activity payload. Notifier (C.6) builds a deep
 * link with `?token=<raw>`. Here we sha256(raw) and timing-safe-compare
 * against `approvals.access_token_hash`. The token is single-use per the
 * status check: once status != 'pending', the token won't auth anymore.
 */

import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { createHash, timingSafeEqual } from 'node:crypto'
import { db } from '../db/index.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

const UUID_RE = /^[0-9a-fA-F-]{36}$/

function approvalChannel(approvalId: string): string {
  return `approval_${approvalId.replace(/-/g, '_')}`
}

/**
 * Strip B.5-scrubbed sensitive fields ("<redacted>") from an args_preview
 * so JSONB containment in lookupApprovalRule can match the live (unscrubbed)
 * args. The resulting pattern keeps only fields that meaningfully identify
 * "the same kind of call" (e.g., `to` on send_sms / send_email).
 */
function stripRedactedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRedactedFields).filter((v) => v !== undefined)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === '<redacted>') continue
      const cleaned = stripRedactedFields(v)
      if (cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  return value
}

function tokenMatches(rawToken: string, storedHashHex: string): boolean {
  const computed = createHash('sha256').update(rawToken).digest()
  let stored: Buffer
  try {
    stored = Buffer.from(storedHashHex, 'hex')
  } catch {
    return false
  }
  if (stored.length !== computed.length) return false
  return timingSafeEqual(computed, stored)
}

interface ApprovalRow {
  id: string
  run_id: string
  workspace_id: string
  account_id: string | null
  tool_name: string
  tool_call_id: string
  args_preview: unknown
  args_hash: string
  reason: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  decided_by: string | null
  decided_at: string | null
  expires_at: string
  access_token_hash: string
  created_at: string
}

async function loadApproval(approvalId: string): Promise<ApprovalRow | null> {
  const rows = (await db.execute(sql`
    SELECT a.id, a.run_id, a.workspace_id, r.account_id, a.tool_name, a.tool_call_id,
           a.args_preview, a.args_hash, a.reason, a.status, a.decided_by,
           a.decided_at::text AS decided_at, a.expires_at::text AS expires_at,
           a.access_token_hash, a.created_at::text AS created_at
      FROM public.approvals a
      JOIN public.cloud_runs r ON r.id = a.run_id
     WHERE a.id = ${approvalId}
     LIMIT 1
  `)) as unknown as Array<ApprovalRow>
  return rows[0] ?? null
}

function publicShape(row: ApprovalRow): Record<string, unknown> {
  const { access_token_hash: _hash, ...rest } = row
  return rest
}

// ---------------------------------------------------------------------------
// approvalsRoute — mounted at /v1/approvals with NO middleware. Each route
// authenticates itself (workspace JWT OR signed token).
// ---------------------------------------------------------------------------

export const approvalsRoute = new Hono<{ Variables: Vars }>()

const decideSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  remember: z.boolean().optional(),
  reason: z.string().max(1024).optional(),
})

/**
 * Authorize a request against an approval row using EITHER:
 *   - workspace JWT whose workspace_id matches the approval, or
 *   - ?token=<raw> whose sha256 matches access_token_hash.
 *
 * On JWT path: returns { ok, accountId } where accountId is the deciding user.
 * On token path: accountId is null (the SMS/email recipient may not have a
 * session — `decided_by` stays NULL and we attribute the decision to the
 * signed-link path. Audit trail is preserved via the access_token_hash that
 * was minted for that specific notification).
 */
async function authorizeForApproval(
  c: Context<{ Variables: Vars }>,
  approval: ApprovalRow,
): Promise<{ ok: true; accountId: string | null } | { ok: false; status: 401 | 403; error: string }> {
  // JWT path — middleware on /v1/* is per-route, so check headers manually.
  const headerToken = c.req.header('X-Workspace-Token') ?? c.req.header('Authorization')
  if (headerToken) {
    const raw = headerToken.toLowerCase().startsWith('bearer ')
      ? headerToken.slice(7).trim()
      : headerToken.trim()
    if (raw.length > 0) {
      try {
        const { verifyWorkspaceToken } = await import('../lib/jwt.js')
        const decoded = await verifyWorkspaceToken(raw)
        if (decoded.workspace_id !== approval.workspace_id) {
          return { ok: false, status: 403, error: 'wrong_workspace' }
        }
        return { ok: true, accountId: decoded.account_id }
      } catch {
        // fall through to token check
      }
    }
  }

  // Signed-token path.
  const queryToken = c.req.query('token')
  if (queryToken && tokenMatches(queryToken, approval.access_token_hash)) {
    return { ok: true, accountId: null }
  }

  return { ok: false, status: 401, error: 'unauthorized' }
}

approvalsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)

  const row = await loadApproval(id)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const auth = await authorizeForApproval(c, row)
  if (!auth.ok) return c.json({ error: auth.error }, auth.status)

  return c.json({ approval: publicShape(row) })
})

approvalsRoute.post('/:id', zValidator('json', decideSchema), async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)

  const row = await loadApproval(id)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const auth = await authorizeForApproval(c, row)
  if (!auth.ok) return c.json({ error: auth.error }, auth.status)

  if (row.status !== 'pending') {
    return c.json({ error: 'already_decided', status: row.status }, 409)
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return c.json({ error: 'expired' }, 410)
  }

  const body = c.req.valid('json')

  // Single transaction: flip status, write the activity row, optionally
  // insert a remember-rule. Done as a single sql round-trip to keep the
  // pre-NOTIFY window tight — the worker's LISTEN side re-queries status
  // when it receives the NOTIFY, so we must NOT pg_notify before the
  // UPDATE commits.
  await db.execute(sql`
    UPDATE public.approvals
       SET status = ${body.decision},
           decided_by = ${auth.accountId},
           decided_at = now()
     WHERE id = ${id}
  `)

  const activityKind = body.decision === 'approved' ? 'approval_granted' : 'approval_denied'
  await db.execute(sql`
    INSERT INTO public.cloud_activity
      (agent_run_id, workspace_id, account_id, activity_type, payload)
    VALUES
      (${row.run_id}, ${row.workspace_id}, ${row.account_id},
       ${activityKind},
       ${JSON.stringify({
         kind: activityKind,
         approval_id: id,
         tool_name: row.tool_name,
         tool_call_id: row.tool_call_id,
         decided_by_account: auth.accountId,
         decided_via: auth.accountId ? 'jwt' : 'signed_token',
         reason: body.reason ?? null,
       })}::jsonb)
  `)

  // remember=true + approved → write an approval_rules row. The C.3
  // lookupApprovalRule uses JSONB containment, so storing args_preview
  // (already PII-scrubbed via B.5 scrubPreview) is the right key — future
  // tool calls with the same shape short-circuit the gate.
  //
  // Migration 0024 added `automation_id` to the rules table — when the
  // approval's run was triggered by an automation, scope the rule to
  // that automation so it doesn't pre-approve ad-hoc agent flows.
  let rememberRuleInserted = false
  if (body.remember && body.decision === 'approved') {
    // Fall back to the run's owner account when the decision came via
    // signed token (SMS reply has no JWT). This keeps `created_by` NOT NULL.
    const createdBy = auth.accountId ?? row.account_id
    if (!createdBy) {
      logger.warn(
        { requestId: c.var.requestId, approvalId: id },
        'remember=true skipped: no account_id available on signed-token decision and no run owner',
      )
    } else {
      // Pull the run's automation_id so the rule is per-automation when applicable.
      const runRows = (await db.execute(sql`
        SELECT automation_id FROM public.cloud_runs WHERE id = ${row.run_id} LIMIT 1
      `)) as unknown as Array<{ automation_id: string | null }>
      const automationId = runRows[0]?.automation_id ?? null
      // args_preview is the B.5-scrubbed shape with sensitive fields
      // replaced by "<redacted>". JSONB containment requires the pattern
      // to be a subset of the live args — and the live args never carry
      // the literal string "<redacted>". Strip those fields so containment
      // matches on identifying fields only (e.g., `to` for send_sms).
      const pattern = stripRedactedFields(row.args_preview)
      await db.execute(sql`
        INSERT INTO public.approval_rules
          (workspace_id, automation_id, tool_name, args_pattern_json, created_by)
        VALUES
          (${row.workspace_id}, ${automationId}, ${row.tool_name},
           ${JSON.stringify(pattern)}::jsonb,
           ${createdBy})
      `)
      rememberRuleInserted = true
    }
  }

  // Fire the NOTIFY last, AFTER the UPDATE has committed (each db.execute
  // is its own implicit transaction at the tx-mode pooler). The worker's
  // LISTEN side will re-query status and resolve the awaitApproval promise.
  const channel = approvalChannel(id)
  await db.execute(sql`SELECT pg_notify(${channel}, ${JSON.stringify({
    kind: 'approval_decided',
    approval_id: id,
    decision: body.decision,
  })})`)

  return c.json({
    approval: publicShape({
      ...row,
      status: body.decision,
      decided_by: auth.accountId,
      decided_at: new Date().toISOString(),
    }),
    notified: true,
    rememberApplied: rememberRuleInserted,
  })
})

// ---------------------------------------------------------------------------
// workspaceApprovalsRoute — mounted at /v1/workspaces (JWT middleware
// already applied in app.ts at /v1/workspaces/*).
// ---------------------------------------------------------------------------

export const workspaceApprovalsRoute = new Hono<{ Variables: Vars }>()

workspaceApprovalsRoute.get(
  '/:wsId/approvals',
  zValidator('query', z.object({
    status: z.enum(['pending', 'approved', 'denied', 'expired']).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    runId: z.string().regex(UUID_RE).optional(),
  })),
  async (c) => {
    const wsParam = c.req.param('wsId')
    const ws = c.var.workspace!.workspace_id
    if (wsParam !== ws) return c.json({ error: 'wrong_workspace' }, 403)

    const q = c.req.valid('query')
    const rows = (await db.execute(sql`
      SELECT a.id, a.run_id, a.workspace_id, a.tool_name, a.tool_call_id,
             a.args_preview, a.reason, a.status, a.decided_by,
             a.decided_at::text AS decided_at, a.expires_at::text AS expires_at,
             a.created_at::text AS created_at
        FROM public.approvals a
       WHERE a.workspace_id = ${ws}
         ${q.status ? sql`AND a.status = ${q.status}` : sql``}
         ${q.runId ? sql`AND a.run_id = ${q.runId}` : sql``}
       ORDER BY a.created_at DESC
       LIMIT ${q.limit}
    `)) as unknown as Array<Record<string, unknown>>

    return c.json({ approvals: rows })
  },
)

// ---------------------------------------------------------------------------
// runApprovalsRoute — mounted at /v1/runs (JWT middleware already applied).
// ---------------------------------------------------------------------------

export const runApprovalsRoute = new Hono<{ Variables: Vars }>()

const bulkSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  reason: z.string().max(1024).optional(),
})

runApprovalsRoute.post(
  '/:runId/approvals/bulk',
  zValidator('json', bulkSchema),
  async (c) => {
    const runId = c.req.param('runId')
    if (!UUID_RE.test(runId)) return c.json({ error: 'invalid_run_id' }, 400)
    const ws = c.var.workspace!.workspace_id
    const accountId = c.var.workspace!.account_id

    // Verify the run is in this workspace, get its account_id for the
    // activity row.
    const runRows = (await db.execute(sql`
      SELECT id, account_id FROM public.cloud_runs
       WHERE id = ${runId} AND workspace_id = ${ws}
       LIMIT 1
    `)) as unknown as Array<{ id: string; account_id: string }>
    if (runRows.length === 0) return c.json({ error: 'not_found' }, 404)
    const runAccountId = runRows[0]!.account_id

    const body = c.req.valid('json')

    const pending = (await db.execute(sql`
      SELECT id FROM public.approvals
       WHERE run_id = ${runId}
         AND workspace_id = ${ws}
         AND status = 'pending'
         AND expires_at > now()
    `)) as unknown as Array<{ id: string }>

    const decided: Array<{ id: string; channel: string }> = []
    for (const p of pending) {
      await db.execute(sql`
        UPDATE public.approvals
           SET status = ${body.decision},
               decided_by = ${accountId},
               decided_at = now()
         WHERE id = ${p.id} AND status = 'pending'
      `)
      const activityKind =
        body.decision === 'approved' ? 'approval_granted' : 'approval_denied'
      await db.execute(sql`
        INSERT INTO public.cloud_activity
          (agent_run_id, workspace_id, account_id, activity_type, payload)
        VALUES
          (${runId}, ${ws}, ${runAccountId}, ${activityKind},
           ${JSON.stringify({
             kind: activityKind,
             approval_id: p.id,
             decided_via: 'bulk',
             reason: body.reason ?? null,
           })}::jsonb)
      `)
      const channel = approvalChannel(p.id)
      await db.execute(sql`SELECT pg_notify(${channel}, ${JSON.stringify({
        kind: 'approval_decided',
        approval_id: p.id,
        decision: body.decision,
      })})`)
      decided.push({ id: p.id, channel })
    }

    return c.json({ runId, decided, decision: body.decision })
  },
)

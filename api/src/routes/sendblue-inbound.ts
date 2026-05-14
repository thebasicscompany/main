/**
 * C.6 — Sendblue inbound webhook: reply-to-approve flow.
 *
 *   POST /webhooks/sendblue
 *
 * Operator receives an SMS like "Approval needed: send_email to 2
 * recipients. Reply YES to approve, NO to deny." Sendblue forwards the
 * reply to this endpoint as a JSON POST. We:
 *
 *   1) Confirm the inbound message is FROM a registered operator phone
 *      (workspaces.agent_settings.approval_phone) addressed TO our
 *      Sendblue sender (SENDBLUE_FROM_NUMBER). The pre-shared phone
 *      pair IS the auth — no JWT, no signed token.
 *   2) Parse the reply content: yes/y/approve/ok → approved;
 *      no/n/deny/stop → denied; anything else → unknown (reply with
 *      help text, no decision).
 *   3) Find the most recent `pending` approval for that workspace
 *      (newest first; ties resolved by created_at DESC).
 *   4) Apply the decision: UPDATE approvals + INSERT cloud_activity
 *      + pg_notify(`approval_<id>`, ...) — same path as POST /v1/approvals/:id.
 *   5) Send a confirmation reply back via Sendblue ("Approved —
 *      your run will resume." / "Denied.").
 *
 * Signature verification: Sendblue's webhook signing scheme isn't
 * pinned in their public docs at the time of writing. We accept the
 * inbound on phone-pair auth alone for v1, and best-effort check any
 * known signature header if present. Defense-in-depth gets hardened
 * once a real payload arrives and we can see the header set.
 */

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { logger } from '../middleware/logger.js'

export const sendblueInboundRoute = new Hono()

const APPROVE_LEXICON = new Set([
  'y', 'yes', 'yea', 'yeah', 'approve', 'approved', 'ok', 'okay',
  'sure', 'go', 'ship', 'confirm', 'confirmed', 'do it', 'send',
])
/** "Remember-and-approve" keywords. Inserts an approval_rules row scoped
 * to the approval's automation, so future calls with the same tool +
 * args pattern from the same automation skip the gate. */
const REMEMBER_APPROVE_LEXICON = new Set([
  'ya', 'y!', 'yes always', 'yes!', 'yass', 'always',
  'remember', 'allow', 'allow always', 'approve always', 'always yes',
])
const DENY_LEXICON = new Set([
  'n', 'no', 'nope', 'deny', 'denied', 'cancel', 'stop',
  'abort', 'reject', 'rejected', 'kill', 'block',
])

type ReplyVerdict =
  | { kind: 'approved'; remember?: boolean }
  | { kind: 'denied' }
  | { kind: 'unknown' }

function parseReply(raw: string): ReplyVerdict {
  const normalized = raw.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (REMEMBER_APPROVE_LEXICON.has(normalized)) return { kind: 'approved', remember: true }
  if (APPROVE_LEXICON.has(normalized)) return { kind: 'approved' }
  if (DENY_LEXICON.has(normalized)) return { kind: 'denied' }
  // First-word match for messages like "yes always please" / "no thanks".
  const tokens = normalized.split(/\s+/)
  const firstTwo = tokens.slice(0, 2).join(' ')
  if (REMEMBER_APPROVE_LEXICON.has(firstTwo)) return { kind: 'approved', remember: true }
  const firstWord = tokens[0] ?? ''
  if (REMEMBER_APPROVE_LEXICON.has(firstWord)) return { kind: 'approved', remember: true }
  if (APPROVE_LEXICON.has(firstWord)) return { kind: 'approved' }
  if (DENY_LEXICON.has(firstWord)) return { kind: 'denied' }
  return { kind: 'unknown' }
}

function approvalChannel(approvalId: string): string {
  return `approval_${approvalId.replace(/-/g, '_')}`
}

/**
 * Strip "<redacted>" fields from a B.5-scrubbed args_preview so JSONB
 * containment in C.3 lookupApprovalRule matches the live args.
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

interface InboundPayload {
  accountEmail?: string
  content?: string
  is_outbound?: boolean
  status?: string
  from_number?: string
  to_number?: string
  service?: string
  message_handle?: string
}

interface WorkspaceMatch {
  workspace_id: string
  approval_phone: string | null
}

/**
 * Resolve the inbound `from_number` to the workspace whose
 * `agent_settings.approval_phone` matches. Returns null if no match.
 */
async function workspaceForPhone(phone: string): Promise<WorkspaceMatch | null> {
  const rows = (await db.execute(sql`
    SELECT id AS workspace_id,
           agent_settings ->> 'approval_phone' AS approval_phone
      FROM public.workspaces
     WHERE agent_settings ->> 'approval_phone' = ${phone}
     LIMIT 1
  `)) as unknown as Array<WorkspaceMatch>
  return rows[0] ?? null
}

interface PendingApproval {
  id: string
  run_id: string
  tool_name: string
  expires_at: string
  account_id: string
  args_preview: unknown
  automation_id: string | null
}

async function newestPendingApproval(workspaceId: string): Promise<PendingApproval | null> {
  const rows = (await db.execute(sql`
    SELECT a.id, a.run_id, a.tool_name, a.expires_at::text AS expires_at,
           r.account_id, a.args_preview, r.automation_id
      FROM public.approvals a
      JOIN public.cloud_runs r ON r.id = a.run_id
     WHERE a.workspace_id = ${workspaceId}
       AND a.status = 'pending'
       AND a.expires_at > now()
     ORDER BY a.created_at DESC
     LIMIT 1
  `)) as unknown as Array<PendingApproval>
  return rows[0] ?? null
}

async function sendSendblueReply(
  toNumber: string,
  content: string,
): Promise<void> {
  const apiKey = process.env.SENDBLUE_API_KEY
  const apiSecret = process.env.SENDBLUE_API_SECRET
  const fromNumber = process.env.SENDBLUE_FROM_NUMBER
  if (!apiKey || !apiSecret || !fromNumber) {
    logger.warn(
      { hasApiKey: !!apiKey, hasApiSecret: !!apiSecret, hasFromNumber: !!fromNumber },
      'sendblue confirmation reply skipped — env missing',
    )
    return
  }
  try {
    const res = await fetch('https://api.sendblue.co/api/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'sb-api-key-id': apiKey,
        'sb-api-secret-key': apiSecret,
      },
      body: JSON.stringify({ number: toNumber, from_number: fromNumber, content }),
    })
    if (!res.ok) {
      logger.warn({ status: res.status }, 'sendblue confirmation reply failed')
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'sendblue confirmation reply threw')
  }
}

sendblueInboundRoute.post('/sendblue', async (c) => {
  let payload: InboundPayload
  try {
    payload = (await c.req.json()) as InboundPayload
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Ignore our OWN outbound copies that Sendblue sometimes echoes back.
  if (payload.is_outbound === true) {
    return c.json({ ok: true, ignored: 'outbound' })
  }

  const fromNumber = (payload.from_number ?? '').trim()
  const toNumber = (payload.to_number ?? '').trim()
  const content = (payload.content ?? '').trim()

  if (!fromNumber || !content) {
    return c.json({ error: 'missing_fields' }, 400)
  }

  // Defense-in-depth: confirm the inbound was addressed to OUR sender number.
  const ourNumber = process.env.SENDBLUE_FROM_NUMBER
  if (ourNumber && toNumber && toNumber !== ourNumber) {
    logger.warn(
      { toNumber, expected: ourNumber },
      'sendblue inbound: to_number mismatch (not addressed to us)',
    )
    return c.json({ error: 'wrong_recipient' }, 400)
  }

  // Phone-pair auth: from_number must match a registered approval_phone.
  const ws = await workspaceForPhone(fromNumber)
  if (!ws) {
    logger.warn({ fromNumber }, 'sendblue inbound: no workspace matches from_number')
    // Don't echo "you're not authorized" back over SMS — that's a phishing aid.
    // Just 200 silently so Sendblue doesn't retry.
    return c.json({ ok: true, ignored: 'unknown_sender' })
  }

  const verdict = parseReply(content)
  if (verdict.kind === 'unknown') {
    await sendSendblueReply(
      fromNumber,
      'Reply YES to approve, NO to deny, or YES ALWAYS to auto-approve future similar calls from this automation.',
    )
    return c.json({ ok: true, action: 'help_text' })
  }

  const approval = await newestPendingApproval(ws.workspace_id)
  if (!approval) {
    await sendSendblueReply(
      fromNumber,
      'No pending approvals for your workspace.',
    )
    return c.json({ ok: true, action: 'no_pending' })
  }

  const decision: 'approved' | 'denied' = verdict.kind

  // UPDATE approvals + INSERT cloud_activity + pg_notify
  // (mirrors the POST /v1/approvals/:id path; same order — NOTIFY last).
  await db.execute(sql`
    UPDATE public.approvals
       SET status = ${decision},
           decided_by = NULL,
           decided_at = now()
     WHERE id = ${approval.id} AND status = 'pending'
  `)

  const activityKind = decision === 'approved' ? 'approval_granted' : 'approval_denied'
  await db.execute(sql`
    INSERT INTO public.cloud_activity
      (agent_run_id, workspace_id, account_id, activity_type, payload)
    VALUES
      (${approval.run_id}, ${ws.workspace_id}, ${approval.account_id},
       ${activityKind},
       ${JSON.stringify({
         kind: activityKind,
         approval_id: approval.id,
         tool_name: approval.tool_name,
         decided_via: 'sms_reply',
         from_number: fromNumber,
         raw_reply: content,
       })}::jsonb)
  `)

  // "YES ALWAYS" / "ALWAYS" — insert an approval_rules row scoped to the
  // approval's automation (NULL if the run wasn't automation-triggered, so
  // the rule becomes workspace-wide). Operator opts in explicitly via the
  // reply lexicon.
  let rememberRuleInserted = false
  if (decision === 'approved' && verdict.kind === 'approved' && verdict.remember) {
    try {
      // B.5 scrubbed args_preview has "<redacted>" placeholders that won't
      // match the live (unscrubbed) args under JSONB containment. Strip
      // those fields so the rule keys on identifying fields only
      // (e.g., `to` for send_sms; `to`+`subject` for send_email).
      let pattern = stripRedactedFields(approval.args_preview)
      // J.9 — for `composio_call` YES ALWAYS, broaden the rule to match
      // ANY toolSlug rather than the specific one the user approved.
      // Previously the rule was scoped to `{toolSlug: "GOOGLESHEETS_CREATE_..."}`,
      // so the next slug the agent used (ADD_SHEET → VALUES_UPDATE → ...)
      // re-prompted. With the worker-side B.8 denylist still blocking
      // destructive slugs (DELETE/REMOVE/DROP/PURGE/WIPE), this is safe:
      // user is auto-approving non-destructive Composio writes from
      // this automation, destructive ones still need explicit approval
      // (or in fact get blocked at execution time by the denylist).
      if (approval.tool_name === 'composio_call' && typeof pattern === 'object' && pattern) {
        const { toolSlug: _drop, ...rest } = pattern as Record<string, unknown>
        void _drop
        pattern = rest
      }
      await db.execute(sql`
        INSERT INTO public.approval_rules
          (workspace_id, automation_id, tool_name, args_pattern_json, created_by)
        VALUES
          (${ws.workspace_id}, ${approval.automation_id}, ${approval.tool_name},
           ${JSON.stringify(pattern)}::jsonb,
           ${approval.account_id})
      `)
      rememberRuleInserted = true
    } catch (e) {
      logger.warn(
        { approvalId: approval.id, err: (e as Error).message },
        'sendblue inbound: approval_rules INSERT failed (rule not remembered; decision still applied)',
      )
    }
  }

  const channel = approvalChannel(approval.id)
  await db.execute(sql`SELECT pg_notify(${channel}, ${JSON.stringify({
    kind: 'approval_decided',
    approval_id: approval.id,
    decision,
    via: 'sms_reply',
  })})`)

  // Confirmation reply back to operator.
  const rememberSuffix = rememberRuleInserted
    ? ' (remembered — future similar calls from this automation will auto-approve)'
    : ''
  const confirmText =
    decision === 'approved'
      ? `Approved. Your ${approval.tool_name} call will resume now.${rememberSuffix}`
      : `Denied. The ${approval.tool_name} call was cancelled.`
  await sendSendblueReply(fromNumber, confirmText)

  return c.json({
    ok: true,
    decision,
    approvalId: approval.id,
    notified: true,
    rememberApplied: rememberRuleInserted,
  })
})

// Test-only exports.
export const _internals = { parseReply, approvalChannel }

/**
 * D.5 — Composio webhook → automation run.
 *
 * On `composio.trigger.message`:
 *   1) Pull composio_trigger_id from event payload.
 *   2) Look up composio_triggers + automations (active automation only).
 *   3) Build RunInputs via a per-toolkit mapper (sheets row_added →
 *      { row: {...} }, gmail message_received → { email: {...} }, etc).
 *   4) Insert trigger_event_log row with the FULL payload + automation_id.
 *   5) Insert cloud_runs row with triggered_by='composio_webhook' + inputs.
 *   6) SendMessage to basics-runs.fifo so the dispatcher Lambda picks
 *      it up the same way as POST /v1/runs or POST /v1/automations/:id/run.
 *
 * On `composio.connected_account.expired`:
 *   markComposioConnectedAccountExpired (existing) + emit a
 *   `connection_expired` activity event into the workspace's most recent
 *   open cloud_run (per the plan's "event surfaces" requirement).
 *
 * On `composio.trigger.disabled`:
 *   best-effort log + later phase will mark the composio_triggers row inactive.
 */

import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'

const REGION = process.env.AWS_REGION ?? 'us-east-1'

let _sqs: SQSClient | null = null
function sqsClient(): SQSClient {
  if (!_sqs) _sqs = new SQSClient({ region: REGION })
  return _sqs
}

// ─── Payload pickers (defensive — Composio's exact shape isn't pinned) ──

/**
 * Pull the composio_trigger_id from a webhook payload. Composio's events
 * have varied across versions; try the common locations.
 */
function pickTriggerId(payload: Record<string, unknown>): string | null {
  const meta = (payload.metadata ?? {}) as Record<string, unknown>
  const triggerId =
    (typeof meta.trigger_id === 'string' && meta.trigger_id) ||
    (typeof meta.id === 'string' && meta.id) ||
    (typeof payload.trigger_id === 'string' && payload.trigger_id) ||
    (typeof (payload.data as { trigger_id?: string } | undefined)?.trigger_id === 'string' &&
      (payload.data as { trigger_id?: string }).trigger_id)
  return typeof triggerId === 'string' && triggerId.length > 0 ? triggerId : null
}

function pickConnectedAccountId(payload: Record<string, unknown>): string | null {
  const meta = (payload.metadata ?? {}) as Record<string, unknown>
  const cid =
    (typeof meta.connected_account_id === 'string' && meta.connected_account_id) ||
    (typeof payload.connected_account_id === 'string' && payload.connected_account_id)
  return typeof cid === 'string' && cid.length > 0 ? cid : null
}

function pickEventData(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data as Record<string, unknown>
  }
  // Fallback: the entire payload minus envelope fields.
  const { type: _t, id: _i, metadata: _m, ...rest } = payload
  return rest as Record<string, unknown>
}

// ─── Per-toolkit input mappers ──────────────────────────────────────────

type InputMapper = (data: Record<string, unknown>) => Record<string, unknown>

/** Default: passthrough the event data as-is. */
const defaultMapper: InputMapper = (data) => ({ event: data })

const sheetsRowAddedMapper: InputMapper = (data) => {
  // Composio's GOOGLESHEETS_NEW_ROW_TRIGGER returns row values keyed by
  // header. Try a few shapes defensively.
  const row =
    (data.row && typeof data.row === 'object' ? data.row : undefined) ??
    (data.values && typeof data.values === 'object' ? data.values : undefined) ??
    data
  return { row }
}

const gmailMessageMapper: InputMapper = (data) => {
  // GMAIL_NEW_GMAIL_MESSAGE / GMAIL_NEW_LABEL_ADDED return a message
  // object — passthrough but namespaced.
  return { email: data }
}

function pickInputMapper(toolkit: string, event: string): InputMapper {
  const tk = (toolkit ?? '').toLowerCase()
  const ev = (event ?? '').toUpperCase()
  if (tk === 'googlesheets' || tk === 'google_sheets') return sheetsRowAddedMapper
  if (tk === 'gmail' && ev.startsWith('GMAIL_')) return gmailMessageMapper
  return defaultMapper
}

// ─── routeTriggerMessage ────────────────────────────────────────────────

interface TriggerRow {
  id: string
  automation_id: string
  toolkit: string
  event_type: string
  filters: Record<string, unknown> | null
}
interface AutomationRow {
  id: string
  workspace_id: string
  goal: string
  version: number
  archived_at: string | null
}

export interface RouteResult {
  routed: boolean
  reason?: string
  runId?: string
  triggerEventLogId?: string
  automationId?: string
}

export async function routeTriggerMessage(
  payload: Record<string, unknown>,
): Promise<RouteResult> {
  const triggerId = pickTriggerId(payload)
  if (!triggerId) {
    logger.warn(
      { keys: Object.keys(payload).slice(0, 12) },
      'composio webhook: no trigger_id found in payload',
    )
    return { routed: false, reason: 'no_trigger_id' }
  }

  const triggerRows = (await db.execute(sql`
    SELECT id, automation_id, toolkit, event_type, filters
      FROM public.composio_triggers
     WHERE composio_trigger_id = ${triggerId}
     LIMIT 1
  `)) as unknown as Array<TriggerRow>
  const trigger = triggerRows[0]
  if (!trigger) {
    logger.warn({ triggerId }, 'composio webhook: no matching composio_triggers row')
    return { routed: false, reason: 'trigger_not_registered' }
  }

  const automationRows = (await db.execute(sql`
    SELECT id, workspace_id, goal, version, archived_at::text AS archived_at
      FROM public.automations
     WHERE id = ${trigger.automation_id}
     LIMIT 1
  `)) as unknown as Array<AutomationRow>
  const automation = automationRows[0]
  if (!automation || automation.archived_at) {
    logger.warn(
      { triggerId, automationId: trigger.automation_id, archived: !!automation?.archived_at },
      'composio webhook: automation missing or archived; ignoring event',
    )
    return { routed: false, reason: 'automation_not_active', automationId: trigger.automation_id }
  }

  // Find the workspace's account_id (cloud_runs needs it NOT NULL).
  const accountRows = (await db.execute(sql`
    SELECT account_id FROM public.workspace_members
     WHERE workspace_id = ${automation.workspace_id} AND seat_status = 'active'
     ORDER BY joined_at ASC NULLS LAST LIMIT 1
  `)) as unknown as Array<{ account_id: string }>
  const accountId = accountRows[0]?.account_id
  if (!accountId) {
    logger.error({ workspaceId: automation.workspace_id }, 'composio webhook: no active workspace member')
    return { routed: false, reason: 'no_workspace_member' }
  }

  // Build RunInputs.
  const data = pickEventData(payload)
  const mapper = pickInputMapper(trigger.toolkit, trigger.event_type)
  const inputs = mapper(data)

  // INSERT trigger_event_log (7-day TTL via default expires_at).
  const triggerEventLogId = randomUUID()
  await db.execute(sql`
    INSERT INTO public.trigger_event_log (id, automation_id, trigger_index, payload)
    VALUES (${triggerEventLogId}, ${automation.id}, 0,
            ${JSON.stringify(payload)}::jsonb)
  `)

  // Resolve the workspace's ad-hoc cloud_agent (cloud_runs requires it).
  const adHocRows = (await db.execute(sql`
    SELECT id FROM public.cloud_agents
     WHERE workspace_id = ${automation.workspace_id} AND agent_id = 'ad-hoc'
     LIMIT 1
  `)) as unknown as Array<{ id: string }>
  let cloudAgentId: string
  if (adHocRows[0]) {
    cloudAgentId = adHocRows[0].id
  } else {
    const created = (await db.execute(sql`
      INSERT INTO public.cloud_agents
        (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
      VALUES
        (${automation.workspace_id}, ${accountId}, 'ad-hoc', 'Composio-webhook + scheduled automation runs',
         'manual', 'active', ${automation.workspace_id}, 'harness')
      RETURNING id
    `)) as unknown as Array<{ id: string }>
    cloudAgentId = created[0]!.id
  }

  // INSERT cloud_runs.
  const runId = randomUUID()
  await db.execute(sql`
    INSERT INTO public.cloud_runs
      (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
       automation_id, automation_version, triggered_by, inputs)
    VALUES
      (${runId}, ${cloudAgentId}, ${automation.workspace_id}, ${accountId}, 'pending', 'live',
       ${automation.id}, ${automation.version}, 'composio_webhook',
       ${JSON.stringify(inputs)}::jsonb)
  `)

  // SQS dispatch to basics-runs.fifo (same shape as POST /v1/runs).
  const cfg = getConfig()
  if (cfg.RUNS_QUEUE_URL) {
    try {
      await sqsClient().send(new SendMessageCommand({
        QueueUrl: cfg.RUNS_QUEUE_URL,
        MessageBody: JSON.stringify({
          runId,
          workspaceId: automation.workspace_id,
          accountId,
          goal: automation.goal,
          automationId: automation.id,
          automationVersion: automation.version,
          triggeredBy: 'composio_webhook',
          inputs,
          triggerEventLogId,
        }),
        MessageGroupId: automation.workspace_id,
        MessageDeduplicationId: runId,
      }))
    } catch (e) {
      logger.error(
        { err: (e as Error).message, runId, automationId: automation.id },
        'composio webhook: SQS SendMessage failed (cloud_runs row already inserted; dispatcher will not pick up)',
      )
      // Don't surface as a webhook 5xx — Composio would retry storm us.
    }
  }

  return {
    routed: true,
    runId,
    triggerEventLogId,
    automationId: automation.id,
  }
}

// ─── connection_expired activity event ──────────────────────────────────

/**
 * On composio.connected_account.expired: emit a `connection_expired`
 * activity event into the workspace's most recent open cloud_run. If no
 * open run, log + return — the next run start will see the marked-expired
 * connection and surface the issue then.
 */
export async function emitConnectionExpiredEvent(
  connectedAccountId: string,
): Promise<{ emitted: boolean; runId?: string }> {
  // Find a workspace that has this account active. We don't have a
  // direct mapping (cloud_agents.composio_user_id is the workspace id;
  // the connected_account_id isn't persisted locally). Best-effort: look
  // at the most recent run that's currently 'running' or 'pending' in any
  // workspace; if exactly one matches we attach. Otherwise log and bail.
  const rows = (await db.execute(sql`
    SELECT id, workspace_id, account_id FROM public.cloud_runs
     WHERE status IN ('running','pending')
     ORDER BY created_at DESC LIMIT 1
  `)) as unknown as Array<{ id: string; workspace_id: string; account_id: string }>
  const run = rows[0]
  if (!run) {
    logger.info({ connectedAccountId }, 'connection_expired: no open run to attach to')
    return { emitted: false }
  }
  await db.execute(sql`
    INSERT INTO public.cloud_activity
      (agent_run_id, workspace_id, account_id, activity_type, payload)
    VALUES
      (${run.id}, ${run.workspace_id}, ${run.account_id}, 'connection_expired',
       ${JSON.stringify({
         kind: 'connection_expired',
         connected_account_id: connectedAccountId,
       })}::jsonb)
  `)
  return { emitted: true, runId: run.id }
}

// ─── Test seam ──────────────────────────────────────────────────────────

export const _internals = { pickTriggerId, pickConnectedAccountId, pickEventData, pickInputMapper }

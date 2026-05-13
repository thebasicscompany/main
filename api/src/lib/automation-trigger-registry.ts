/**
 * D.4 — Automation trigger registration / cleanup.
 *
 * For each declared trigger in `automation.triggers[]`:
 *   - `composio_webhook` → call ComposioClient.createTrigger and persist
 *      a `composio_triggers` row tying the automation to the trigger id.
 *   - `schedule` (recurring or one-shot) → create an
 *      `aws.scheduler.Schedule` named `automation-<automation_id>-<index>`
 *      whose target is the basics-cron-kicker Lambda (reusing the same
 *      target the cloud_agents schedule path uses).
 *   - `manual` → no side effect.
 *
 * On automation update we diff the prior triggers vs. the new ones and
 * apply only the delta. On automation delete (or trigger removal) we
 * remove the corresponding Composio + Scheduler entities.
 *
 * All third-party calls are best-effort: a Composio outage MUST NOT
 * block the CRUD response. Failures are returned as `warnings` so the
 * caller can surface them in the route response.
 */

import { sql } from 'drizzle-orm'
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
  ConflictException,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler'
import { ComposioClient, ComposioUnavailableError } from '@basics/shared'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'

const REGION = process.env.AWS_REGION ?? 'us-east-1'

let _scheduler: SchedulerClient | null = null
function schedulerClient(): SchedulerClient {
  if (!_scheduler) _scheduler = new SchedulerClient({ region: REGION })
  return _scheduler
}

/** Test seam — let tests inject a stub Composio client. */
let _composio: ComposioClient | null | undefined
export function setComposioClientForTests(client: ComposioClient | null): void {
  _composio = client
}
function composioClient(): ComposioClient | null {
  if (_composio !== undefined) return _composio
  try {
    return new ComposioClient()
  } catch (e) {
    if (e instanceof ComposioUnavailableError) return null
    throw e
  }
}

// ─── Trigger types (mirror automations.ts Zod shapes) ────────────────────

export type ComposioWebhookTrigger = {
  type: 'composio_webhook'
  toolkit: string
  event: string
  filters?: Record<string, unknown>
}
export type ScheduleTrigger =
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'schedule'; at: string }
export type ManualTrigger = { type: 'manual' }
export type AnyTrigger = ManualTrigger | ScheduleTrigger | ComposioWebhookTrigger

// ─── Schedule helpers ────────────────────────────────────────────────────

function scheduleNameForAutomation(automationId: string, triggerIndex: number): string {
  // Schedule names must be <= 64 chars, [a-zA-Z0-9-_.]
  return `automation-${automationId}-${triggerIndex}`
}

/**
 * Convert a standard 5-field cron expression (m h dom mon dow) to
 * EventBridge Scheduler's 6-field format (m h dom mon dow year) with
 * the EB-specific constraint that exactly ONE of dom/dow must be `?`
 * (EventBridge rejects `* * * * *` because both wildcards collide).
 *
 * Heuristic: if day-of-week is anything other than `*`, swap day-of-month
 * to `?`. Otherwise swap day-of-week to `?`. Year defaults to `*`.
 */
function toEventBridgeCron(cron5: string): string {
  const parts = cron5.trim().split(/\s+/)
  if (parts.length !== 5) return cron5  // pass through; CreateSchedule will error
  let [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  if (dow !== '*') dom = '?'
  else dow = '?'
  return `${m} ${h} ${dom} ${mon} ${dow} *`
}

function scheduleExpression(trigger: ScheduleTrigger): {
  expression: string
  timezone?: string
} {
  if ('cron' in trigger) {
    return { expression: `cron(${toEventBridgeCron(trigger.cron)})`, timezone: trigger.timezone }
  }
  // one-shot: at: '2026-06-01T09:00:00Z' → at(2026-06-01T09:00:00)
  const isoNoTz = trigger.at.replace(/Z$/, '').replace(/\.\d+$/, '')
  return { expression: `at(${isoNoTz})`, timezone: 'UTC' }
}

interface ScheduleTargetInput {
  workspaceId: string
  accountId: string
  automationId: string
  goal: string
}
function buildScheduleTargetInput(input: ScheduleTargetInput): string {
  // Mirrors the cloud-schedules cron-kicker payload shape so we can reuse
  // the existing dispatcher Lambda. The kicker mints a runId, INSERTs
  // cloud_runs, and SQS-sends to basics-runs.fifo. (Extending it to
  // populate automation_id/automation_version on the cloud_runs row is
  // a follow-up step — D.5/D.6.)
  return JSON.stringify({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    automationId: input.automationId,
    goal: input.goal,
    triggeredBy: 'schedule',
  })
}

// ─── Reconciliation ──────────────────────────────────────────────────────

export interface ReconcileInput {
  workspaceId: string
  accountId: string
  automationId: string
  goal: string
  priorTriggers: AnyTrigger[]
  nextTriggers: AnyTrigger[]
  /** Workspace's connected Composio user (= workspace_id by convention). */
  composioUserId: string
  /** Connected account id per toolkit, looked up at reconcile time. */
  connectedAccountByToolkit: Record<string, string>
}

export interface ReconcileResult {
  added: Array<{ index: number; kind: AnyTrigger['type']; ref?: string }>
  removed: Array<{ index: number; kind: AnyTrigger['type']; ref?: string }>
  warnings: Array<{ index: number; kind: AnyTrigger['type']; message: string }>
}

/**
 * Naive diff: index-by-index. We don't try to recognize "trigger moved
 * from index 0 to index 1"; renumbering = delete + recreate. Cheap and
 * deterministic.
 */
function triggerSignature(t: AnyTrigger): string {
  return JSON.stringify(t)
}

export async function reconcileTriggers(input: ReconcileInput): Promise<ReconcileResult> {
  const cfg = getConfig()
  const result: ReconcileResult = { added: [], removed: [], warnings: [] }

  const priorSigs = input.priorTriggers.map(triggerSignature)
  const nextSigs = input.nextTriggers.map(triggerSignature)

  // Removed: indexes that existed in prior but no longer match.
  for (let i = 0; i < input.priorTriggers.length; i++) {
    const t = input.priorTriggers[i]!
    if (priorSigs[i] === nextSigs[i]) continue // unchanged at this index
    if (t.type === 'composio_webhook') {
      const row = await loadComposioTriggerRow(input.automationId, i, t.event)
      if (row) {
        const client = composioClient()
        if (client) {
          try {
            await client.deleteTrigger(row.composio_trigger_id)
          } catch (e) {
            result.warnings.push({
              index: i, kind: t.type,
              message: `composio deleteTrigger failed: ${(e as Error).message}`,
            })
          }
        }
        await db.execute(sql`
          DELETE FROM public.composio_triggers WHERE id = ${row.id}
        `)
        result.removed.push({ index: i, kind: t.type, ref: row.composio_trigger_id })
      }
    } else if (t.type === 'schedule') {
      const name = scheduleNameForAutomation(input.automationId, i)
      try {
        await schedulerClient().send(new DeleteScheduleCommand({ Name: name, GroupName: 'default' }))
        result.removed.push({ index: i, kind: t.type, ref: name })
      } catch (e) {
        if (e instanceof ResourceNotFoundException) {
          result.removed.push({ index: i, kind: t.type, ref: name })
        } else {
          result.warnings.push({
            index: i, kind: t.type,
            message: `scheduler DeleteSchedule(${name}) failed: ${(e as Error).message}`,
          })
        }
      }
    }
  }

  // Added: indexes whose signature changed or is new.
  for (let i = 0; i < input.nextTriggers.length; i++) {
    const t = input.nextTriggers[i]!
    if (priorSigs[i] === nextSigs[i]) continue
    if (t.type === 'composio_webhook') {
      const callbackUrl =
        (cfg.BASICS_ALLOWED_ORIGINS?.split(',').find((o) => o.includes('api.trybasics')) ?? 'https://api.trybasics.ai')
          .replace(/\/$/, '') + '/webhooks/composio'
      const client = composioClient()
      if (!client) {
        result.warnings.push({
          index: i, kind: t.type,
          message: 'composio_unavailable: COMPOSIO_API_KEY not set or ComposioClient construction failed',
        })
        continue
      }
      const connectedAccountId = input.connectedAccountByToolkit[t.toolkit.toLowerCase()]
        ?? input.connectedAccountByToolkit[t.toolkit]
      if (!connectedAccountId) {
        result.warnings.push({
          index: i, kind: t.type,
          message: `no_connected_account_for_toolkit=${t.toolkit}; trigger NOT registered`,
        })
        continue
      }
      try {
        const { triggerId } = await client.createTrigger({
          toolkit: t.toolkit,
          eventType: t.event,
          callbackUrl,
          connectedAccountId,
          ...(t.filters ? { filters: t.filters } : {}),
        })
        await db.execute(sql`
          INSERT INTO public.composio_triggers
            (automation_id, composio_trigger_id, toolkit, event_type, filters)
          VALUES
            (${input.automationId}, ${triggerId}, ${t.toolkit}, ${t.event},
             ${t.filters ? JSON.stringify(t.filters) : null}::jsonb)
        `)
        result.added.push({ index: i, kind: t.type, ref: triggerId })
      } catch (e) {
        result.warnings.push({
          index: i, kind: t.type,
          message: `composio createTrigger failed: ${(e as Error).message}`,
        })
      }
    } else if (t.type === 'schedule') {
      if (!cfg.CRON_KICKER_LAMBDA_ARN || !cfg.SCHEDULER_INVOKE_ROLE_ARN) {
        result.warnings.push({
          index: i, kind: t.type,
          message: 'scheduler_not_configured: CRON_KICKER_LAMBDA_ARN or SCHEDULER_INVOKE_ROLE_ARN unset',
        })
        continue
      }
      const name = scheduleNameForAutomation(input.automationId, i)
      const sched = scheduleExpression(t)
      const params = {
        Name: name,
        GroupName: 'default',
        ScheduleExpression: sched.expression,
        ...(sched.timezone ? { ScheduleExpressionTimezone: sched.timezone } : {}),
        State: 'ENABLED' as const,
        FlexibleTimeWindow: { Mode: 'OFF' as const },
        Target: {
          Arn: cfg.CRON_KICKER_LAMBDA_ARN,
          RoleArn: cfg.SCHEDULER_INVOKE_ROLE_ARN,
          Input: buildScheduleTargetInput({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            automationId: input.automationId,
            goal: input.goal,
          }),
        },
        ActionAfterCompletion: 'NONE' as const,
      }
      try {
        await schedulerClient().send(new CreateScheduleCommand(params))
        result.added.push({ index: i, kind: t.type, ref: name })
      } catch (e) {
        if (e instanceof ConflictException) {
          // Idempotent: update.
          try {
            await schedulerClient().send(new UpdateScheduleCommand(params))
            result.added.push({ index: i, kind: t.type, ref: name })
          } catch (e2) {
            result.warnings.push({
              index: i, kind: t.type,
              message: `scheduler UpdateSchedule(${name}) failed: ${(e2 as Error).message}`,
            })
          }
        } else {
          result.warnings.push({
            index: i, kind: t.type,
            message: `scheduler CreateSchedule(${name}) failed: ${(e as Error).message}`,
          })
        }
      }
    }
  }

  if (result.warnings.length > 0) {
    logger.warn(
      { automationId: input.automationId, warnings: result.warnings },
      'reconcileTriggers: partial registration',
    )
  }
  return result
}

/** Tear down ALL trigger registrations for an automation (used on archive/delete). */
export async function teardownAllTriggers(
  automationId: string,
  triggers: AnyTrigger[],
): Promise<ReconcileResult> {
  return reconcileTriggers({
    workspaceId: '',
    accountId: '',
    automationId,
    goal: '',
    priorTriggers: triggers,
    nextTriggers: [],
    composioUserId: '',
    connectedAccountByToolkit: {},
  })
}

// ─── DB helpers ──────────────────────────────────────────────────────────

interface ComposioTriggerRow {
  id: string
  composio_trigger_id: string
}
async function loadComposioTriggerRow(
  automationId: string,
  _index: number,
  eventType: string,
): Promise<ComposioTriggerRow | null> {
  // We don't store the trigger_index, so match on (automation_id, event_type).
  // Edge case: multiple composio_webhook triggers with the same event would
  // collide here — accepted limitation; D.x can extend the row to include
  // the trigger_index if needed.
  const rows = (await db.execute(sql`
    SELECT id, composio_trigger_id FROM public.composio_triggers
     WHERE automation_id = ${automationId} AND event_type = ${eventType}
     LIMIT 1
  `)) as unknown as Array<ComposioTriggerRow>
  return rows[0] ?? null
}

/**
 * Lookup connected accounts for a workspace by toolkit slug.
 *
 * The worker (worker/src/composio/connection-resolver.ts) uses the JWT's
 * `account_id` as Composio's user_id. Matching that convention here so
 * trigger registration finds the same connections the runtime uses.
 * If `composioUserId` is omitted, fall back to whatever the workspace's
 * ad-hoc cloud_agent has stored (legacy path).
 *
 * Returns ACTIVE connections only — EXPIRED/INITIALIZING aren't usable
 * for trigger subscriptions. The map's keys are LOWERCASE toolkit slugs.
 */
export async function loadConnectedAccountByToolkit(
  workspaceId: string,
  composioUserId?: string,
): Promise<Record<string, string>> {
  let userId = composioUserId
  if (!userId) {
    const rows = (await db.execute(sql`
      SELECT composio_user_id
        FROM public.cloud_agents
       WHERE workspace_id = ${workspaceId}
       LIMIT 1
    `)) as unknown as Array<{ composio_user_id: string | null }>
    userId = rows[0]?.composio_user_id ?? workspaceId
  }

  const client = composioClient()
  if (!client) return {}
  try {
    const accounts = await client.listConnectedAccounts(userId)
    const byToolkit: Record<string, string> = {}
    for (const acc of accounts) {
      // Only ACTIVE accounts can subscribe to triggers.
      if (acc.status && acc.status.toUpperCase() !== 'ACTIVE') continue
      const toolkit = (acc.toolkit?.slug ?? '').toLowerCase()
      if (toolkit && !byToolkit[toolkit]) byToolkit[toolkit] = acc.id
    }
    return byToolkit
  } catch (e) {
    logger.warn(
      { workspaceId, userId, err: (e as Error).message },
      'loadConnectedAccountByToolkit: composio listConnectedAccounts failed',
    )
    return {}
  }
}

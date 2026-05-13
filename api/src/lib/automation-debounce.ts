/**
 * D.7 — Trigger debouncing.
 *
 * Before dispatching a fresh run for an automation, check that no run
 * was created for the same automation within the configured debounce
 * window. The window defaults to 30 s and can be overridden per-trigger
 * via `automation.triggers[i].debounce_ms`.
 *
 * The spec recommends `pg_try_advisory_xact_lock(hashtext(automation_id))`
 * to serialize concurrent webhook handlers. In this codebase every
 * db.execute is its own auto-commit transaction (no wrapping tx layer),
 * so an xact-scoped advisory lock would release immediately and offer
 * no real protection. Instead we rely on the time-window SELECT alone —
 * acceptable for the realistic load (Composio webhooks aren't fanned out
 * faster than the DB roundtrip + INSERT). Documented gap; a future
 * hardening pass could wrap the check + INSERT in a transaction.
 *
 * The activity-event emit on skip writes a `trigger_debounced` row into
 * the LATEST cloud_run for the automation (the one we'd be debouncing
 * AGAINST), so the operator sees the suppression in the run's activity
 * stream.
 */

import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'

export const DEFAULT_DEBOUNCE_MS = 30_000

export type DebounceTrigger = {
  type?: string
  debounce_ms?: number
}

/**
 * Resolve the effective debounce window from automation.triggers[].
 * If multiple triggers declare debounce_ms, use the MIN (most aggressive)
 * so an automation's lowest-latency declared trigger sets the lower bound.
 */
export function resolveDebounceMs(
  triggers: ReadonlyArray<DebounceTrigger> | unknown,
  fallbackMs: number = DEFAULT_DEBOUNCE_MS,
): number {
  if (!Array.isArray(triggers)) return fallbackMs
  let min = fallbackMs
  for (const t of triggers as DebounceTrigger[]) {
    if (t && typeof t.debounce_ms === 'number' && t.debounce_ms >= 0) {
      if (t.debounce_ms < min) min = t.debounce_ms
    }
  }
  return min
}

export interface DebounceCheckResult {
  debounce: boolean
  latestRunId?: string
  latestRunCreatedAt?: string
  workspaceId?: string
  accountId?: string
}

/**
 * Look for a cloud_run on this automation that was created within the
 * debounce window. Returns the most-recent such row if any.
 *
 * Uses `db` (drizzle) for callers in the api process.
 */
export async function checkAutomationDebounce(
  automationId: string,
  debounceMs: number,
): Promise<DebounceCheckResult> {
  if (debounceMs <= 0) return { debounce: false }
  const intervalSec = Math.max(1, Math.ceil(debounceMs / 1000))
  const rows = (await db.execute(sql`
    SELECT id, created_at::text AS created_at, workspace_id, account_id
      FROM public.cloud_runs
     WHERE automation_id = ${automationId}
       AND created_at > now() - (${intervalSec}::int * interval '1 second')
     ORDER BY created_at DESC
     LIMIT 1
  `)) as unknown as Array<{
    id: string
    created_at: string
    workspace_id: string
    account_id: string
  }>
  const latest = rows[0]
  if (!latest) return { debounce: false }
  return {
    debounce: true,
    latestRunId: latest.id,
    latestRunCreatedAt: latest.created_at,
    workspaceId: latest.workspace_id,
    accountId: latest.account_id,
  }
}

/**
 * Emit a `trigger_debounced` cloud_activity event into the supplied run.
 */
export async function emitTriggerDebouncedEvent(opts: {
  runId: string
  workspaceId: string
  accountId: string
  automationId: string
  triggerKind: 'composio_webhook' | 'schedule'
  windowMs: number
  detail?: Record<string, unknown>
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.cloud_activity
      (agent_run_id, workspace_id, account_id, activity_type, payload)
    VALUES
      (${opts.runId}, ${opts.workspaceId}, ${opts.accountId}, 'trigger_debounced',
       ${JSON.stringify({
         kind: 'trigger_debounced',
         automation_id: opts.automationId,
         trigger_kind: opts.triggerKind,
         window_ms: opts.windowMs,
         debounced_at: new Date().toISOString(),
         ...(opts.detail ?? {}),
       })}::jsonb)
  `)
}

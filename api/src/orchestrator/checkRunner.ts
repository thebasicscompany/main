/**
 * Check runner — Phase 06.
 *
 * Orchestrates post-workflow check execution. Called from `runFiber` after
 * the workflow body completes, before the run is finalized:
 *
 *   workflow body → checkRunner → flip status to verified|unverified
 *                                   ↓
 *                            run_completed (always emitted for backward compat)
 *
 * Behavior:
 *  - Each scheduled check runs sequentially. (Parallel execution is out of
 *    scope for v1 — checks are I/O-bound but typically <5 per workflow,
 *    and serial keeps the SSE timeline readable.)
 *  - For each check we emit `check_started` before invocation, persist the
 *    `{ passed, evidence }` row to `runtime_check_results`, then emit
 *    `check_completed` with the same payload.
 *  - A check throwing is treated as `passed=false` with the error in
 *    evidence — never crashes the runner. The whole point of checks is
 *    forensic durability; one flaky check shouldn't stop the rest.
 *  - Final status: all-pass → `verified`. Any-fail (including caught
 *    throws) → `unverified`. Empty list (zero scheduled checks) → no-op,
 *    leaves status untouched (the workflow's earlier `completed` mark
 *    still stands when run.ts moves the status update inside this).
 */

import type { CdpSession } from '@basics/harness'
import type { CheckContext, ScheduledCheck } from '../checks/types.js'
import { logger } from '../middleware/logger.js'
import { record as recordCheckResult } from './checkResultsRepo.js'
import { publish } from './eventbus.js'

export interface RunChecksInput {
  runId: string
  workspaceId: string
  checks: ScheduledCheck[]
  /** Free-form workflow output forwarded to each check via `ctx.runResult`. */
  runResult?: unknown
  /**
   * Per-workspace credential map. Phase 09 lands the actual vault; for now
   * the orchestrator passes whatever it has (typically empty) and stub
   * checks ignore it.
   */
  toolCredentials?: Record<string, string>
  /**
   * The CDP session attached for the workflow body. Browser-based check
   * primitives (`crm_field_equals`, `record_count_changed`,
   * `slack_message_posted`) reuse this so they can read DOM inside the
   * agent's already-authenticated tab. Optional so non-browser checks and
   * tests omit it.
   */
  session?: CdpSession
  /**
   * `runtime_workflows.id` (or a built-in workflow name). Plumbed through
   * to checks that need to look up prior runs scoped to the same workflow
   * (e.g. `record_count_changed` baseline).
   */
  workflowId?: string
}

export interface RunChecksSummary {
  /** Total checks attempted. Equals `checks.length` from the input. */
  total: number
  /** How many returned `passed: true`. */
  passed: number
  /** How many returned `passed: false` OR threw. */
  failed: number
  /** Terminal verdict. Caller flips `runtime_runs.status` to this. */
  outcome: 'verified' | 'unverified' | 'no_checks'
}

/**
 * Run all scheduled checks sequentially. Persistence + SSE emission per
 * check is best-effort — failures inside the runner machinery are logged
 * but do not throw to the caller. The caller handles the run-status
 * transition based on the returned `outcome`.
 */
export async function runChecks(
  input: RunChecksInput,
): Promise<RunChecksSummary> {
  if (input.checks.length === 0) {
    return { total: 0, passed: 0, failed: 0, outcome: 'no_checks' }
  }

  const ctx: CheckContext = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    toolCredentials: input.toolCredentials ?? {},
    ...(input.runResult !== undefined ? { runResult: input.runResult } : {}),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
  }

  let passedCount = 0
  let failedCount = 0

  for (const scheduled of input.checks) {
    publish(input.runId, {
      type: 'check_started',
      data: {
        check_name: scheduled.name,
        ts: new Date().toISOString(),
      },
    })

    let passed = false
    let evidence: unknown = null
    try {
      const result = await scheduled.fn(ctx)
      passed = result.passed
      evidence = result.evidence
    } catch (err) {
      passed = false
      evidence = {
        reason: 'check_threw',
        error: err instanceof Error ? err.message : String(err),
      }
      logger.warn(
        {
          run_id: input.runId,
          check_name: scheduled.name,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'check function threw; recording as failed',
      )
    }

    if (passed) passedCount++
    else failedCount++

    // Persist before emitting `check_completed` so any reader hooked to
    // the SSE event can immediately query the row by run_id.
    try {
      await recordCheckResult({
        runId: input.runId,
        checkName: scheduled.name,
        passed,
        evidence,
      })
    } catch (err) {
      // Persistence failures are concerning but should not block the
      // pipeline — the SSE event still goes out so live consumers see
      // the verdict, and the orchestrator finishes the run.
      logger.error(
        {
          run_id: input.runId,
          check_name: scheduled.name,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'failed to persist check result',
      )
    }

    publish(input.runId, {
      type: 'check_completed',
      data: {
        check_name: scheduled.name,
        passed,
        evidence,
        ts: new Date().toISOString(),
      },
    })
  }

  const outcome: RunChecksSummary['outcome'] =
    failedCount === 0 ? 'verified' : 'unverified'

  return {
    total: input.checks.length,
    passed: passedCount,
    failed: failedCount,
    outcome,
  }
}

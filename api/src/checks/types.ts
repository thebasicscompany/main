/**
 * Check function types — Phase 06.
 *
 * A "check" is a TS module that runs at the end of a workflow to verify
 * the run achieved its claimed outcome. Each check returns
 * `{ passed, evidence }` and the orchestrator persists every result to
 * `runtime.runtime_check_results`. All-pass flips the run status to
 * `verified`; any-fail flips it to `unverified` (a terminal state alongside
 * `completed` / `failed`).
 *
 * Browser-based primitives (Phase 11+):
 *  - `session` is the agent's already-attached CDP session, surfaced so
 *    checks can navigate inside the same Browserbase tab the workflow ran
 *    in. The session is alive when checks run (the lifecycle in
 *    `runFiber` calls `runChecks` BEFORE `detach`/`stopBrowserbaseSession`).
 *  - Optional so non-browser checks (e.g. `url_contains`) and unit tests
 *    can omit it. Primitives that strictly need a session should fail
 *    cleanly with a structured `reason: 'no_session'` evidence row.
 *  - `workflowId` is plumbed through so checks like
 *    `record_count_changed` can look up prior baselines scoped to the
 *    same workflow.
 */

import type { CdpSession } from '@basics/harness'

export interface CheckContext {
  runId: string
  workspaceId: string
  /**
   * `runtime_workflows.id` (or a built-in workflow name like
   * `'hello-world'`). Optional for back-compat with tests that don't
   * care; primitives that need it for baseline lookups should defensively
   * skip when missing.
   */
  workflowId?: string
  /**
   * The CDP session the orchestrator attached for the workflow body.
   * Browser-based checks reuse this to navigate inside the same
   * authenticated Browserbase tab — they should NOT spawn fresh sessions.
   * Optional so non-browser checks and tests can omit it.
   */
  session?: CdpSession
  /**
   * Per-workspace tool credentials looked up by the orchestrator before
   * dispatching checks. Empty in v1 — Phase 09 lands the credential vault.
   */
  toolCredentials: Record<string, string>
  /**
   * Output of the workflow itself, when the workflow chose to expose one.
   * Free-form so each playbook can populate whatever shape its checks
   * need. Always optional — most checks query external systems anyway.
   */
  runResult?: unknown
}

export interface CheckResult {
  passed: boolean
  evidence: unknown
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckResult>

/**
 * One scheduled check invocation: the function to run plus a human-readable
 * `name` for the audit row + SSE event payload, plus optional per-call
 * params the check function reads off the bound closure (each primitive
 * exposes a factory that returns a `CheckFn` with params already baked in).
 */
export interface ScheduledCheck {
  /** Stable identifier persisted to `runtime_check_results.check_name`. */
  name: string
  fn: CheckFn
}

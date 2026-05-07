/**
 * Per-run take-over coordination — Phase 08.
 *
 * The agent loop checks `isTakeoverActive(runId)` between LLM iterations
 * (NOT mid-iteration; per ARCHITECTURE.md:179–207 the loop check is between
 * tool calls). When active, the loop awaits `awaitResume(runId)` — a
 * Promise-based gate that resolves when the run's POST /resume route fires
 * `signalResume(runId)`.
 *
 * Mirrors the shape of `approvalSignal.ts`: in-process Map of waiters,
 * Promise resolved by an external callsite. No DB durability — restart
 * mid-takeover means the run dies (same posture as approval mid-run).
 *
 * Take-over is a process-wide flag (one waiter per run). Concurrent
 * `markTakeoverStarted` calls are rejected by `runs.ts` at the route layer
 * with 409 — this module does not police duplicates beyond clobbering an
 * existing waiter (which would never happen in practice given the route
 * 409s).
 */

interface TakeoverState {
  active: boolean
  startedAt: string | null
  startedBy: string | null
  /** Resolver registered by the agent loop's `awaitResume` call. */
  resolveResume: (() => void) | null
}

const states = new Map<string, TakeoverState>()

function ensureState(runId: string): TakeoverState {
  let s = states.get(runId)
  if (!s) {
    s = { active: false, startedAt: null, startedBy: null, resolveResume: null }
    states.set(runId, s)
  }
  return s
}

/**
 * Flip the takeover flag on for `runId`. Returns the start timestamp.
 *
 * The route layer is responsible for the 409-if-already-active check; this
 * fn is idempotent in the second-call-wins sense (it overwrites the prior
 * `startedAt`/`startedBy`) but the route's pre-check makes that path dead.
 */
export function markTakeoverStarted(
  runId: string,
  accountId: string,
): { startedAt: string } {
  const s = ensureState(runId)
  const startedAt = new Date().toISOString()
  s.active = true
  s.startedAt = startedAt
  s.startedBy = accountId
  return { startedAt }
}

/**
 * Flip the takeover flag off and wake any waiter blocked on `awaitResume`.
 *
 * Returns `true` if a waiter existed (so the caller can know whether the
 * loop was actively gated, useful for telemetry); `false` if the flag was
 * just a flag with no fiber waiting on it (e.g. the route fires resume
 * before the loop reached its next gate check).
 */
export function markTakeoverEnded(runId: string): boolean {
  const s = states.get(runId)
  if (!s) return false
  s.active = false
  s.startedAt = null
  s.startedBy = null
  const resolve = s.resolveResume
  s.resolveResume = null
  if (resolve) {
    resolve()
    return true
  }
  return false
}

/** Whether the run is currently in take-over. */
export function isTakeoverActive(runId: string): boolean {
  return states.get(runId)?.active === true
}

/** Snapshot for tests/diagnostics. */
export function getTakeoverState(runId: string): {
  active: boolean
  startedAt: string | null
  startedBy: string | null
} {
  const s = states.get(runId)
  if (!s) return { active: false, startedAt: null, startedBy: null }
  return { active: s.active, startedAt: s.startedAt, startedBy: s.startedBy }
}

/**
 * Block until `markTakeoverEnded` flips the flag off. The agent loop calls
 * this between iterations only after observing `isTakeoverActive === true`;
 * if the flag flips off in the gap between the check and this call, the
 * caller should re-check before awaiting (cheap, no race window matters
 * because the loop just iterates again).
 *
 * Resolves immediately if the run is not currently in takeover (handles the
 * race where resume lands between the loop's flag-check and its
 * `awaitResume` call).
 */
export function awaitResume(runId: string): Promise<void> {
  const s = ensureState(runId)
  if (!s.active) return Promise.resolve()
  return new Promise<void>((resolve) => {
    s.resolveResume = resolve
  })
}

/** Test-only: drop all per-run state. */
export function __resetForTests(): void {
  // Resolve any outstanding waiters so awaiting tests don't hang.
  for (const s of states.values()) {
    if (s.resolveResume) s.resolveResume()
  }
  states.clear()
}

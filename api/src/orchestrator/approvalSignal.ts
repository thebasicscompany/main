/**
 * Per-approval Promise registry — Phase 04B.
 *
 * The approval middleware blocks the orchestrator's tool dispatch fiber on
 * `awaitResolution(approvalId, expiresAt)`. The resolve route handler calls
 * `signalResolution(approvalId, decision)` to wake that Promise. A
 * 30-minute (configurable via `expiresAt`) `setTimeout` is armed at
 * `awaitResolution` time so a never-resolved approval falls through with
 * `source: 'timeout'` even if no signal arrives.
 *
 * Durability caveat (called out in the Phase 04B brief): if the runtime
 * process restarts mid-approval, the in-memory waiter Map is lost and the
 * orchestrator fiber that was blocked on it is gone too. The approval row
 * stays `pending` in DB until the timeout sweeper fires (Phase 05/09 owns
 * a durable signaling story). v1 deliberately accepts this — restart
 * mid-run = run dies anyway.
 */

interface PendingWaiter {
  resolve: (
    value: { decision: 'approve' | 'reject'; source: 'user' | 'timeout' },
  ) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingResolutions = new Map<string, PendingWaiter>()

/**
 * Block until the approval is resolved (signal or timeout).
 *
 * Returns `{ decision, source: 'user' }` if `signalResolution` fired,
 * `{ decision: 'reject', source: 'timeout' }` if the deadline passed first.
 *
 * Multiple concurrent `awaitResolution` calls for the same approvalId are
 * not supported — the middleware only ever creates one waiter per row, and
 * a second registration would silently clobber the first.
 */
export function awaitResolution(
  approvalId: string,
  expiresAt: Date,
): Promise<{ decision: 'approve' | 'reject'; source: 'user' | 'timeout' }> {
  return new Promise((resolve) => {
    const ms = Math.max(0, expiresAt.getTime() - Date.now())
    const timer = setTimeout(() => {
      const entry = pendingResolutions.get(approvalId)
      if (entry) {
        pendingResolutions.delete(approvalId)
        entry.resolve({ decision: 'reject', source: 'timeout' })
      }
    }, ms)
    // setTimeout in Node returns a Timeout object that keeps the event
    // loop alive. unref() lets the process exit during shutdown rather
    // than waiting up to 30 minutes for a stale timer.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref()
    }
    pendingResolutions.set(approvalId, { resolve, timer })
  })
}

/**
 * Wake a waiter. Returns `true` if a waiter existed (and was resolved),
 * `false` otherwise — the route handler treats `false` as "no in-process
 * fiber waiting; DB row is still authoritative."
 */
export function signalResolution(
  approvalId: string,
  decision: 'approve' | 'reject',
): boolean {
  const entry = pendingResolutions.get(approvalId)
  if (!entry) return false
  pendingResolutions.delete(approvalId)
  clearTimeout(entry.timer)
  entry.resolve({ decision, source: 'user' })
  return true
}

/** Test-only: drop all waiters. */
export function __resetForTests(): void {
  for (const { timer } of pendingResolutions.values()) {
    clearTimeout(timer)
  }
  pendingResolutions.clear()
}

/** Test-only: count of in-flight waiters. */
export function __pendingCount(): number {
  return pendingResolutions.size
}

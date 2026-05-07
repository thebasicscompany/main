/**
 * In-memory pub/sub for run events, keyed by run_id.
 *
 * One channel per run. The orchestrator publishes; the SSE route
 * subscribes. Each channel keeps a bounded ring buffer (REPLAY_BUFFER_SIZE)
 * of recent events so a late-arriving subscriber can replay context before
 * tailing live emissions.
 *
 * Design notes:
 *  - This is the single seam between the orchestrator and SSE consumers.
 *    Phase 05 swaps this for a DB-backed channel, but the public API
 *    (`publish`, `subscribe`, `close`) stays the same.
 *  - Subscribers are async iterators. They terminate when `close()` is
 *    called for the run, or when the consumer drops the iterator (which
 *    triggers the `return()` cleanup path).
 *  - Buffer size of 200 is a heuristic: a hello-world run emits ~6 events,
 *    a plausible Phase 03 agent loop step emits ~4, so 200 = ~50 steps of
 *    history which comfortably covers any single-page replay scenario.
 */

const REPLAY_BUFFER_SIZE = 200

export type RunEventType =
  | 'run_started'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'screenshot_captured'
  | 'model_thinking'
  | 'model_tool_use'
  | 'agent_summary'
  | 'run_completed'
  | 'run_failed'
  | 'approval_pending'
  | 'approval_resolved'
  | 'approval_timeout'
  | 'check_started'
  | 'check_completed'
  | 'takeover_started'
  | 'takeover_ended'
  | 'trust_grant_suggested'

export interface RunEvent {
  /** Monotonic per-run id (1, 2, 3, ...). Set by the bus, not the publisher. */
  id: number
  type: RunEventType
  data: Record<string, unknown>
}

interface Channel {
  events: RunEvent[]
  consumers: Set<(evt: RunEvent | null) => void>
  closed: boolean
  nextId: number
}

const channels = new Map<string, Channel>()

function getOrCreateChannel(runId: string): Channel {
  let ch = channels.get(runId)
  if (!ch) {
    ch = { events: [], consumers: new Set(), closed: false, nextId: 1 }
    channels.set(runId, ch)
  }
  return ch
}

/**
 * Publish an event to a run's channel. Returns the assigned monotonic id.
 *
 * If `close()` was already called for this run, the publish is a silent
 * no-op (orchestrator may try to flush a final event during shutdown).
 */
export function publish(
  runId: string,
  event: { type: RunEventType; data: Record<string, unknown> },
): number {
  const ch = getOrCreateChannel(runId)
  if (ch.closed) return -1

  const full: RunEvent = {
    id: ch.nextId++,
    type: event.type,
    data: event.data,
  }
  ch.events.push(full)
  while (ch.events.length > REPLAY_BUFFER_SIZE) {
    ch.events.shift()
  }
  // Snapshot consumers — handlers may mutate the set if they unsubscribe.
  const consumers = Array.from(ch.consumers)
  for (const c of consumers) {
    try {
      c(full)
    } catch {
      // never let one bad consumer break delivery for the rest
    }
  }
  return full.id
}

/**
 * Subscribe to a run's events as an async iterable. Replays the buffered
 * history first (in publish order), then tails live events until `close()`
 * is called or the consumer breaks out of iteration.
 *
 * Subscribing to an already-closed run yields the buffered history and
 * then terminates immediately — useful for late SSE connects to a
 * just-finished run.
 */
export function subscribe(runId: string): AsyncIterable<RunEvent> {
  const ch = getOrCreateChannel(runId)
  return makeAsyncIterable(ch)
}

function makeAsyncIterable(ch: Channel): AsyncIterable<RunEvent> {
  return {
    [Symbol.asyncIterator]() {
      // queue is a sliding window of pending events for this consumer.
      // resolve is the pending promise's resolver if next() is awaiting.
      const queue: Array<RunEvent | null> = []
      let waiter: ((value: IteratorResult<RunEvent>) => void) | null = null
      let done = false

      // Seed with replay buffer.
      for (const e of ch.events) queue.push(e)
      // If channel is already closed, push terminator after replay.
      if (ch.closed) queue.push(null)

      const handler = (evt: RunEvent | null) => {
        if (done) return
        if (waiter) {
          const w = waiter
          waiter = null
          if (evt === null) {
            done = true
            w({ value: undefined as unknown as RunEvent, done: true })
          } else {
            w({ value: evt, done: false })
          }
        } else {
          queue.push(evt)
        }
      }
      ch.consumers.add(handler)

      const cleanup = () => {
        done = true
        ch.consumers.delete(handler)
      }

      return {
        next(): Promise<IteratorResult<RunEvent>> {
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as RunEvent,
              done: true,
            })
          }
          if (queue.length > 0) {
            const head = queue.shift() as RunEvent | null
            if (head === null) {
              done = true
              ch.consumers.delete(handler)
              return Promise.resolve({
                value: undefined as unknown as RunEvent,
                done: true,
              })
            }
            return Promise.resolve({ value: head, done: false })
          }
          return new Promise<IteratorResult<RunEvent>>((resolve) => {
            waiter = resolve
          })
        },
        return(): Promise<IteratorResult<RunEvent>> {
          cleanup()
          return Promise.resolve({
            value: undefined as unknown as RunEvent,
            done: true,
          })
        },
      }
    },
  }
}

/**
 * Close a run's channel: signal all current consumers to terminate after
 * draining their pending events, mark the channel closed. Any subsequent
 * `publish()` is a no-op; `subscribe()` will replay the buffer and
 * terminate immediately.
 *
 * The channel + buffer are retained (not deleted) so a brief consumer
 * reconnect immediately after close still sees the full event tail.
 */
export function close(runId: string): void {
  const ch = channels.get(runId)
  if (!ch) return
  if (ch.closed) return
  ch.closed = true
  const consumers = Array.from(ch.consumers)
  for (const c of consumers) {
    try {
      c(null)
    } catch {
      // ignore
    }
  }
}

/** Test-only: drop all channels. Not exported via index. */
export function __resetForTests(): void {
  channels.clear()
}

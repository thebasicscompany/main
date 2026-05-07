import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetForTests,
  close,
  publish,
  subscribe,
  type RunEvent,
} from './eventbus.js'

afterEach(() => {
  __resetForTests()
})

async function collect(
  iter: AsyncIterable<RunEvent>,
  count: number,
  timeoutMs = 1000,
): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  const it = iter[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  while (out.length < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timeout collecting ${count} events`)
    const winner = await Promise.race([
      it.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(
          () => resolve({ done: true, value: undefined }),
          remaining,
        ),
      ),
    ])
    if (winner.done) break
    out.push(winner.value as RunEvent)
  }
  return out
}

describe('eventbus', () => {
  it('replays buffered events to a late subscriber', async () => {
    const runId = 'run-1'
    publish(runId, { type: 'run_started', data: { run_id: runId } })
    publish(runId, {
      type: 'tool_call_started',
      data: { tool: 'navigate' },
    })

    const events = await collect(subscribe(runId), 2)
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('run_started')
    expect(events[0]?.id).toBe(1)
    expect(events[1]?.type).toBe('tool_call_started')
    expect(events[1]?.id).toBe(2)
  })

  it('delivers live events to multiple subscribers', async () => {
    const runId = 'run-2'

    const subA = subscribe(runId)[Symbol.asyncIterator]()
    const subB = subscribe(runId)[Symbol.asyncIterator]()

    const aPromise = subA.next()
    const bPromise = subB.next()

    publish(runId, { type: 'run_started', data: { run_id: runId } })

    const a = await aPromise
    const b = await bPromise
    expect(a.done).toBe(false)
    expect(b.done).toBe(false)
    if (!a.done && !b.done) {
      expect(a.value.type).toBe('run_started')
      expect(b.value.type).toBe('run_started')
      expect(a.value.id).toBe(b.value.id)
    }
  })

  it('terminates iterators when close() is called', async () => {
    const runId = 'run-3'
    publish(runId, { type: 'run_started', data: { run_id: runId } })
    const it = subscribe(runId)[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.done).toBe(false)

    const pending = it.next()
    close(runId)
    const ended = await pending
    expect(ended.done).toBe(true)
  })

  it('replays buffer + ends immediately when subscribing after close', async () => {
    const runId = 'run-4'
    publish(runId, { type: 'run_started', data: { run_id: runId } })
    publish(runId, {
      type: 'run_completed',
      data: { run_id: runId, status: 'completed' },
    })
    close(runId)

    const events = await collect(subscribe(runId), 5)
    // Should yield exactly the 2 buffered events then terminate.
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'run_completed',
    ])
  })

  it('publish after close is a no-op', async () => {
    const runId = 'run-5'
    publish(runId, { type: 'run_started', data: { run_id: runId } })
    close(runId)
    const id = publish(runId, {
      type: 'tool_call_started',
      data: { tool: 'never' },
    })
    expect(id).toBe(-1)
    const events = await collect(subscribe(runId), 5)
    expect(events.map((e) => e.type)).toEqual(['run_started'])
  })

  it('assigns monotonic ids per run', () => {
    const runId = 'run-6'
    const id1 = publish(runId, { type: 'run_started', data: {} })
    const id2 = publish(runId, { type: 'tool_call_started', data: {} })
    const id3 = publish(runId, { type: 'tool_call_completed', data: {} })
    expect(id1).toBe(1)
    expect(id2).toBe(2)
    expect(id3).toBe(3)
  })
})

/**
 * Computer-use dispatcher tests.
 *
 * Each Anthropic action is exercised against a mocked CdpSession and a
 * partially-mocked harness. We assert the dispatcher calls the right
 * harness function with the right args (or sends the right CDP messages
 * for actions that don't have a dedicated helper). Screenshot bytes are
 * not exercised here — the surrounding loop's contract is that every
 * action ends with a fresh screenshot, which is checked by inspecting
 * the returned content shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetForTests as resetAudit,
  __setRunStepRepoForTests,
  __setToolCallRepoForTests,
  createMemoryRunStepRepo,
  createMemoryToolCallRepo,
  listToolCalls,
} from './auditWriter.js'
import { __resetForTests as resetEventbus } from './eventbus.js'

// Mock the harness module so we can assert call args without spinning a
// real CDP client. capture_screenshot returns a tiny base64 payload so the
// content-shape assertions hold without exercising real PNG bytes.
vi.mock('@basics/harness', () => {
  return {
    capture_screenshot: vi.fn(async () => ({
      base64: 'AAA=',
      format: 'png' as const,
    })),
    click_at_xy: vi.fn(async () => undefined),
    type_text: vi.fn(async () => undefined),
    press_key: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
  }
})

// Helper: build a minimal CdpSession-shaped object whose `client.send` we
// can spy on.
function makeMockSession(): { session: any; sends: Array<{ method: string; params: any; sessionId?: string }> } {
  const sends: Array<{ method: string; params: any; sessionId?: string }> = []
  const session = {
    client: {
      send: vi.fn(async (method: string, params: any, sessionId?: string) => {
        sends.push({ method, params, sessionId })
        return {}
      }),
    },
    sessionId: 'sess-1',
    targetId: 'tgt-1',
    wsUrl: 'ws://example',
    events: [],
    pendingDialog: null,
    detach: async () => undefined,
    attachTarget: async () => 'sess-1',
  }
  return { session, sends }
}

beforeEach(() => {
  resetEventbus()
  __setRunStepRepoForTests(createMemoryRunStepRepo())
  __setToolCallRepoForTests(createMemoryToolCallRepo())
  vi.clearAllMocks()
})

afterEach(() => {
  resetEventbus()
  resetAudit()
  __setRunStepRepoForTests(null)
  __setToolCallRepoForTests(null)
})

describe('ComputerUseDispatcher', () => {
  it('screenshot action takes only the trailing screenshot', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    const r = await d.dispatch('tu-1', { action: 'screenshot' })

    expect(harness.capture_screenshot).toHaveBeenCalledTimes(1)
    expect(r.isError).toBe(false)
    expect(r.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA=' },
    })
  })

  it('mouse_move dispatches Input.dispatchMouseEvent type=mouseMoved', async () => {
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session, sends } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-2', { action: 'mouse_move', coordinate: [100, 200] })

    const move = sends.find((s) => s.method === 'Input.dispatchMouseEvent')
    expect(move).toBeTruthy()
    expect(move!.params).toMatchObject({ type: 'mouseMoved', x: 100, y: 200 })
  })

  it('left_click → click_at_xy(left)', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-3', { action: 'left_click', coordinate: [10, 20] })

    expect(harness.click_at_xy).toHaveBeenCalledWith(session, 10, 20, 'left')
  })

  it('right_click and middle_click pass the right button arg', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-r', { action: 'right_click', coordinate: [1, 2] })
    await d.dispatch('tu-m', { action: 'middle_click', coordinate: [3, 4] })

    expect(harness.click_at_xy).toHaveBeenCalledWith(session, 1, 2, 'right')
    expect(harness.click_at_xy).toHaveBeenCalledWith(session, 3, 4, 'middle')
  })

  it('double_click and triple_click pass click counts', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-d', { action: 'double_click', coordinate: [5, 6] })
    await d.dispatch('tu-t', { action: 'triple_click', coordinate: [7, 8] })

    expect(harness.click_at_xy).toHaveBeenCalledWith(session, 5, 6, 'left', 2)
    expect(harness.click_at_xy).toHaveBeenCalledWith(session, 7, 8, 'left', 3)
  })

  it('left_click_drag synthesizes pressed → moved → released', async () => {
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session, sends } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-drag', {
      action: 'left_click_drag',
      start_coordinate: [10, 10],
      coordinate: [50, 60],
    })

    const drag = sends.filter((s) => s.method === 'Input.dispatchMouseEvent')
    expect(drag).toHaveLength(3)
    expect(drag[0]!.params).toMatchObject({ type: 'mousePressed', x: 10, y: 10, button: 'left' })
    expect(drag[1]!.params).toMatchObject({ type: 'mouseMoved', x: 50, y: 60 })
    expect(drag[2]!.params).toMatchObject({ type: 'mouseReleased', x: 50, y: 60, button: 'left' })
  })

  it('key action parses descriptor and calls press_key with modifiers', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-k', { action: 'key', text: 'ctrl+a' })
    // ctrl = 2
    expect(harness.press_key).toHaveBeenCalledWith(session, 'a', 2)

    await d.dispatch('tu-k2', { action: 'key', text: 'shift+ctrl+t' })
    // shift|ctrl = 8|2 = 10
    expect(harness.press_key).toHaveBeenCalledWith(session, 't', 10)

    await d.dispatch('tu-k3', { action: 'key', text: 'Return' })
    // alias maps to Enter
    expect(harness.press_key).toHaveBeenCalledWith(session, 'Enter', 0)
  })

  it('type action calls type_text', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-tp', { action: 'type', text: 'hello world' })
    expect(harness.type_text).toHaveBeenCalledWith(session, 'hello world')
  })

  it('cursor_position is a no-op (returns synthetic position via screenshot)', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    const r = await d.dispatch('tu-cp', { action: 'cursor_position' })

    // No CDP call beyond the trailing screenshot, no harness call.
    expect(harness.click_at_xy).not.toHaveBeenCalled()
    expect(harness.type_text).not.toHaveBeenCalled()
    expect(r.isError).toBe(false)
  })

  it('wait action calls harness wait with seconds', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-w', { action: 'wait', duration: 2 })
    expect(harness.wait).toHaveBeenCalledWith(2)

    await d.dispatch('tu-w2', { action: 'wait' })
    expect(harness.wait).toHaveBeenCalledWith(1) // default 1s
  })

  it('scroll action delegates to harness.scroll with mapped delta', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    await d.dispatch('tu-s', {
      action: 'scroll',
      coordinate: [100, 100],
      scroll_direction: 'down',
      scroll_amount: 3,
    })
    // scroll(session, x, y, dy, dx); down + amount 3 → dy = 300, dx = 0
    expect(harness.scroll).toHaveBeenCalledWith(session, 100, 100, 300, 0)
  })

  it('returns is_error=true and a text block when the action throws', async () => {
    const harness = await import('@basics/harness')
    ;(harness.click_at_xy as any).mockRejectedValueOnce(new Error('boom'))
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    const r = await d.dispatch('tu-fail', {
      action: 'left_click',
      coordinate: [10, 20],
    })

    expect(r.isError).toBe(true)
    const texts = r.content.filter((b: any) => b.type === 'text') as Array<{ text: string }>
    expect(texts[0]?.text).toContain('boom')
    // Screenshot is still appended (closing the action with a fresh view).
    expect(r.content.some((b: any) => b.type === 'image')).toBe(true)
  })

  it('rejects unsupported actions as a tool error (does not throw)', async () => {
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-1', session as any)

    const r = await d.dispatch('tu-x', { action: 'fly' as any })
    expect(r.isError).toBe(true)
    const texts = r.content.filter((b: any) => b.type === 'text') as Array<{ text: string }>
    expect(texts[0]?.text).toMatch(/unsupported/i)
  })
})

describe('ComputerUseDispatcher — audit log interleave (Phase 05)', () => {
  it('writes a tool_call row before harness execution and updates it after success', async () => {
    const harness = await import('@basics/harness')
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-aud-1', session as any)

    await d.dispatch('tu-aud-1', {
      action: 'left_click',
      coordinate: [10, 20],
    })

    // The harness was called; the audit row exists with `result` populated
    // and `error: null` after the successful path.
    expect(harness.click_at_xy).toHaveBeenCalledTimes(1)
    const calls = await listToolCalls('run-aud-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe('computer.left_click')
    expect(calls[0]!.params).toMatchObject({ coordinate: [10, 20] })
    expect(calls[0]!.error).toBeNull()
    expect(calls[0]!.result).not.toBeNull()
    expect(calls[0]!.completedAt).toBeTypeOf('string')
    expect(calls[0]!.startedAt).toBeTypeOf('string')
  })

  it('writes a tool_call row even when the harness throws (error path)', async () => {
    const harness = await import('@basics/harness')
    ;(harness.click_at_xy as any).mockRejectedValueOnce(new Error('boom'))
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-aud-2', session as any)

    const r = await d.dispatch('tu-aud-2', {
      action: 'left_click',
      coordinate: [1, 1],
    })
    expect(r.isError).toBe(true)

    const calls = await listToolCalls('run-aud-2')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.error).toContain('boom')
    // Result is still populated (the model still gets back content blocks).
    expect(calls[0]!.result).not.toBeNull()
    expect(calls[0]!.completedAt).toBeTypeOf('string')
  })

  it('shares step_index between eventbus emit and audit row', async () => {
    const eventbus = await import('./eventbus.js')
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const channel = eventbus.subscribe('run-aud-3')
    const consumeP = (async () => {
      for await (const e of channel) {
        events.push({ type: e.type, data: e.data })
        if (events.length >= 2) break
      }
    })()

    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-aud-3', session as any)

    await d.dispatch('tu-aud-3', { action: 'screenshot' })

    // Allow the eventbus consumer to drain.
    await consumeP

    const startEvt = events.find((e) => e.type === 'tool_call_started')
    expect(startEvt).toBeTruthy()
    const stepIdx = startEvt!.data.step_index as number
    expect(typeof stepIdx).toBe('number')

    const calls = await listToolCalls('run-aud-3')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.stepIndex).toBe(stepIdx)
  })

  it('persists each dispatched action as a separate tool_call row in order', async () => {
    const { ComputerUseDispatcher } = await import('./computerUseDispatcher.js')
    const { session } = makeMockSession()
    const d = new ComputerUseDispatcher('run-aud-4', session as any)

    await d.dispatch('tu-1', { action: 'screenshot' })
    await d.dispatch('tu-2', { action: 'left_click', coordinate: [1, 2] })
    await d.dispatch('tu-3', { action: 'type', text: 'hi' })

    const calls = await listToolCalls('run-aud-4')
    expect(calls.map((tc) => tc.toolName)).toEqual([
      'computer.screenshot',
      'computer.left_click',
      'computer.type',
    ])
    // step_index is monotonic per run.
    const indices = calls.map((tc) => tc.stepIndex)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(new Set(indices).size).toBe(indices.length)
  })
})

describe('parseKeyDescriptor', () => {
  it('parses bare keys', async () => {
    const { parseKeyDescriptor } = await import('./computerUseDispatcher.js')
    expect(parseKeyDescriptor('a')).toEqual({ key: 'a', modifiers: 0 })
  })

  it('maps xdotool aliases', async () => {
    const { parseKeyDescriptor } = await import('./computerUseDispatcher.js')
    expect(parseKeyDescriptor('Return')).toEqual({ key: 'Enter', modifiers: 0 })
    expect(parseKeyDescriptor('Up')).toEqual({ key: 'ArrowUp', modifiers: 0 })
    expect(parseKeyDescriptor('Esc')).toEqual({ key: 'Escape', modifiers: 0 })
  })

  it('combines modifier bits', async () => {
    const { parseKeyDescriptor } = await import('./computerUseDispatcher.js')
    expect(parseKeyDescriptor('alt+shift+a')).toEqual({
      key: 'a',
      modifiers: 1 | 8,
    })
    expect(parseKeyDescriptor('cmd+c')).toEqual({ key: 'c', modifiers: 4 })
  })
})

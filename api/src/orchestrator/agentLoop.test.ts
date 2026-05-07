/**
 * Agent loop tests.
 *
 * The Anthropic call (`runMessages`) and the harness are both mocked;
 * we script `runMessages` to return a sequence of canned responses and
 * assert the loop:
 *   - terminates on `end_turn` (no tool_use blocks),
 *   - dispatches each tool_use to the harness,
 *   - appends tool_result messages back into the conversation,
 *   - caps iterations at `maxIterations`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests as resetEventbus } from './eventbus.js'
import {
  __resetForTests as resetTakeover,
  markTakeoverEnded,
  markTakeoverStarted,
} from './takeoverSignal.js'

// Mock the harness so we can run the loop without a real CDP session.
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

// Mock the Anthropic wrapper. Each test re-arranges the script.
const runMessagesMock = vi.fn()
vi.mock('../lib/anthropic.js', () => ({
  runMessages: (...args: unknown[]) => runMessagesMock(...args),
}))

function mockSession() {
  return {
    client: {
      send: vi.fn(async () => ({})),
    },
    sessionId: 'sess-1',
    targetId: 'tgt-1',
    wsUrl: 'ws://example',
    events: [],
    pendingDialog: null,
    detach: async () => undefined,
    attachTarget: async () => 'sess-1',
  } as any
}

beforeEach(() => {
  resetEventbus()
  resetTakeover()
  runMessagesMock.mockReset()
  vi.clearAllMocks()
})

afterEach(() => {
  resetEventbus()
  resetTakeover()
})

describe('runAgentLoop', () => {
  it('terminates immediately on end_turn (no tool_use)', async () => {
    runMessagesMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'All done.' }],
    })

    const { runAgentLoop } = await import('./agentLoop.js')
    const r = await runAgentLoop({
      runId: 'run-1',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
      maxIterations: 5,
    })

    expect(r.iterations).toBe(1)
    expect(r.finalText).toBe('All done.')
    expect(r.hitMaxIterations).toBe(false)
  })

  it('dispatches tool_use, appends tool_result, then ends', async () => {
    // Turn 1: model takes a screenshot. Turn 2: model is done.
    runMessagesMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me look.' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'computer',
            input: { action: 'screenshot' },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'I see it. Done.' }],
      })

    const { runAgentLoop } = await import('./agentLoop.js')
    const r = await runAgentLoop({
      runId: 'run-2',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
      maxIterations: 5,
    })

    expect(r.iterations).toBe(2)
    expect(r.finalText).toBe('I see it. Done.')
    expect(r.hitMaxIterations).toBe(false)

    // Inspect the second call's `messages` arg — it should contain the
    // assistant turn (with tool_use) followed by a user message carrying
    // a tool_result block tied to tu_1.
    const secondCall = runMessagesMock.mock.calls[1]![0]
    const msgs = secondCall.messages
    // [user(prompt+screenshot), assistant(tool_use), user(tool_result)]
    expect(msgs).toHaveLength(3)
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[2].role).toBe('user')
    const toolResult = (msgs[2].content as any[]).find(
      (b: any) => b.type === 'tool_result',
    )
    expect(toolResult).toBeTruthy()
    expect(toolResult.tool_use_id).toBe('tu_1')
    expect(toolResult.content.some((b: any) => b.type === 'image')).toBe(true)
  })

  it('dispatches multiple tool_use blocks in a single turn', async () => {
    runMessagesMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'computer', input: { action: 'screenshot' } },
          {
            type: 'tool_use',
            id: 'tu_b',
            name: 'computer',
            input: { action: 'left_click', coordinate: [10, 10] },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'k' }],
      })

    const { runAgentLoop } = await import('./agentLoop.js')
    await runAgentLoop({
      runId: 'run-3',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
    })

    const secondCall = runMessagesMock.mock.calls[1]![0]
    const msgs = secondCall.messages
    const lastUser = msgs[msgs.length - 1]
    const toolResults = (lastUser.content as any[]).filter(
      (b: any) => b.type === 'tool_result',
    )
    expect(toolResults).toHaveLength(2)
    expect(toolResults.map((t: any) => t.tool_use_id).sort()).toEqual([
      'tu_a',
      'tu_b',
    ])
  })

  it('caps at maxIterations even when the model keeps calling tools', async () => {
    // Always emit a tool_use so the loop never naturally ends.
    runMessagesMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu_loop',
          name: 'computer',
          input: { action: 'screenshot' },
        },
      ],
    })

    const { runAgentLoop } = await import('./agentLoop.js')
    const r = await runAgentLoop({
      runId: 'run-4',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
      maxIterations: 3,
    })

    expect(r.iterations).toBe(3)
    expect(r.hitMaxIterations).toBe(true)
    expect(runMessagesMock).toHaveBeenCalledTimes(3)
  })

  it('returns a synthetic error tool_result for unknown tools (defense)', async () => {
    runMessagesMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu_unknown', name: 'mystery', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      })

    const { runAgentLoop } = await import('./agentLoop.js')
    await runAgentLoop({
      runId: 'run-5',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
    })

    const secondCall = runMessagesMock.mock.calls[1]![0]
    const msgs = secondCall.messages
    const lastUser = msgs[msgs.length - 1]
    const tr = (lastUser.content as any[])[0]
    expect(tr.type).toBe('tool_result')
    expect(tr.is_error).toBe(true)
    expect(tr.content[0].text).toMatch(/unknown tool/)
  })

  // ===========================================================================
  // Phase 08: take-over gate.
  //
  // The loop must (a) yield between iterations when `isTakeoverActive` is
  // true, (b) NOT call `runMessages` again until the gate is released, and
  // (c) on release, capture a fresh screenshot + inject a synthetic user
  // turn carrying that screenshot.
  // ===========================================================================
  it('yields between iterations when takeover is active and resumes with a fresh user turn', async () => {
    // Strategy: mark takeover BEFORE the loop runs (the loop's first
    // iteration's gate check at the top of the while-body will see it),
    // then schedule `markTakeoverEnded` on a setTimeout so the loop
    // unblocks. After that, the loop calls runMessages once and the
    // model returns end_turn. We assert (a) only one runMessages call,
    // and (b) the synthetic user-turn carrying the resume explanation +
    // fresh screenshot is the last message in the thread.
    runMessagesMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'all good' }],
    })

    const harness = (await import('@basics/harness')) as unknown as {
      capture_screenshot: ReturnType<typeof vi.fn>
    }
    let shotCount = 0
    harness.capture_screenshot.mockImplementation(async () => {
      shotCount++
      return { base64: `shot-${shotCount}`, format: 'png' as const }
    })

    markTakeoverStarted('run-takeover', 'acct-x')
    let runMessagesCallsBeforeResume = -1
    const releaseTimer = setTimeout(() => {
      // Snapshot the runMessages call count at the moment of resume.
      // The loop must NOT have called runMessages yet (the gate is
      // still holding it).
      runMessagesCallsBeforeResume = runMessagesMock.mock.calls.length
      markTakeoverEnded('run-takeover')
    }, 30)

    const { runAgentLoop } = await import('./agentLoop.js')
    const r = await runAgentLoop({
      runId: 'run-takeover',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
      maxIterations: 3,
    })
    clearTimeout(releaseTimer)

    expect(runMessagesCallsBeforeResume).toBe(0)
    expect(r.iterations).toBe(1)
    expect(r.hitMaxIterations).toBe(false)
    expect(runMessagesMock).toHaveBeenCalledTimes(1)

    // The single runMessages call (after the gate releases) should see
    // a thread where the LAST user message carries the synthetic
    // takeover-resume explanation + a fresh screenshot. The loop's
    // initial user-turn (prompt + screenshot) precedes it.
    const firstCall = runMessagesMock.mock.calls[0]![0]
    const msgs = firstCall.messages as Array<{
      role: string
      content: any
    }>
    const lastMsg = msgs[msgs.length - 1]!
    expect(lastMsg.role).toBe('user')
    const blocks = lastMsg.content as Array<{ type: string; text?: string }>
    expect(blocks.some((b) => b.type === 'text' && /paused/.test(b.text!))).toBe(
      true,
    )
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
    // Two screenshots: the initial framing one + the post-resume one.
    expect(harness.capture_screenshot).toHaveBeenCalledTimes(2)
  })

  // ===========================================================================
  // Phase 09: trust_grant_suggested event on takeover-resume.
  //
  // The post-resume hook in agentLoop.ts emits a `trust_grant_suggested`
  // event so a future overlay/dashboard can render an "Auto-approve <last
  // few user actions> next time?" prompt. v1 emits an empty
  // `suggested_actions: []` (engine for extracting actions from the CDP
  // timeline is a Phase 10+ concern). This test pins the event seam so a
  // downstream listener can rely on it.
  // ===========================================================================
  it('emits trust_grant_suggested with empty suggested_actions on takeover resume (Phase 09)', async () => {
    runMessagesMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    })

    const harness = (await import('@basics/harness')) as unknown as {
      capture_screenshot: ReturnType<typeof vi.fn>
    }
    harness.capture_screenshot.mockImplementation(async () => ({
      base64: 'shot',
      format: 'png' as const,
    }))

    markTakeoverStarted('run-suggest', 'acct-x')
    const releaseTimer = setTimeout(() => {
      markTakeoverEnded('run-suggest')
    }, 30)

    // Subscribe to the eventbus before the loop runs so we capture the
    // suggested event live (the replay buffer also covers this, but
    // subscribing up-front is the cleaner contract).
    const eventbus = await import('./eventbus.js')
    const seen: Array<{ type: string; data: Record<string, unknown> }> = []
    const subPromise = (async () => {
      for await (const evt of eventbus.subscribe('run-suggest')) {
        seen.push({ type: evt.type, data: evt.data })
      }
    })()

    const { runAgentLoop } = await import('./agentLoop.js')
    await runAgentLoop({
      runId: 'run-suggest',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
      maxIterations: 3,
    })
    clearTimeout(releaseTimer)
    eventbus.close('run-suggest')
    await subPromise

    const suggested = seen.find((e) => e.type === 'trust_grant_suggested')
    expect(suggested).toBeDefined()
    expect(suggested!.data.run_id).toBe('run-suggest')
    expect(suggested!.data.takeover_started_at).toBeTypeOf('string')
    expect(suggested!.data.takeover_ended_at).toBeTypeOf('string')
    // v1: always empty until the suggestion engine ships (Phase 10+).
    expect(suggested!.data.suggested_actions).toEqual([])
  })

  it('does not call runMessages while takeover is active', async () => {
    // Set takeover BEFORE running the loop, then release it after a
    // delay. The loop must not call runMessages until the gate releases.
    markTakeoverStarted('run-pre-takeover', 'acct-y')

    runMessagesMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'k' }],
    })

    let releasedAt: number | null = null
    const releaseTimer = setTimeout(() => {
      releasedAt = Date.now()
      markTakeoverEnded('run-pre-takeover')
    }, 30)

    const start = Date.now()
    const { runAgentLoop } = await import('./agentLoop.js')
    const r = await runAgentLoop({
      runId: 'run-pre-takeover',
      session: mockSession(),
      systemPrompt: 'sys',
      userPrompt: 'go',
      maxIterations: 3,
    })
    clearTimeout(releaseTimer)

    // The single runMessages call only happened AFTER we released the
    // gate. We approximate this by asserting the loop took at least the
    // gate delay (~30ms) — pass with a generous slack to be CI-stable.
    expect(releasedAt).not.toBeNull()
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(20)
    expect(runMessagesMock).toHaveBeenCalledTimes(1)
    expect(r.iterations).toBe(1)
  })
})

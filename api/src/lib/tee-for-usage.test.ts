import { describe, expect, it } from 'vitest'
import { teeForUsage } from './tee-for-usage.js'
import { AnthropicSseUsageExtractor } from './usage-extractors/anthropic.js'
import type { UsageExtractor } from './usage-extractors/index.js'

function streamFromText(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p))
      controller.close()
    },
  })
}

describe('teeForUsage', () => {
  it('passes bytes through unchanged and fires onUsage at stream end', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":3}}\n\n'
    const upstream = new Response(streamFromText([sse]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    let captured: unknown = undefined
    const teed = teeForUsage(upstream, new AnthropicSseUsageExtractor(), (u) => {
      captured = u
    })
    const text = await teed.text()
    expect(text).toBe(sse)
    expect(captured).toEqual({
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 3,
    })
  })

  it('handles split chunks correctly', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n'
    const upstream = new Response(
      streamFromText([sse.slice(0, 25), sse.slice(25, 80), sse.slice(80)]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    let captured: unknown = undefined
    const teed = teeForUsage(upstream, new AnthropicSseUsageExtractor(), (u) => {
      captured = u
    })
    await teed.text()
    expect(captured).toMatchObject({ inputTokens: 7, outputTokens: 2 })
  })

  it('fires onUsage(null) immediately when body is null', async () => {
    const upstream = new Response(null, { status: 204 })
    let fired = false
    let captured: unknown = 'untouched'
    const teed = teeForUsage(
      upstream,
      // Stub extractor — should never be called.
      {
        feed: () => {
          throw new Error('feed should not be called')
        },
        finish: () => null,
      } satisfies UsageExtractor,
      (u) => {
        fired = true
        captured = u
      },
    )
    expect(teed.status).toBe(204)
    // onUsage is fired in a microtask
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toBe(true)
    expect(captured).toBeNull()
  })

  it('fires onUsage exactly once even if extractor.finish throws', async () => {
    const upstream = new Response(streamFromText(['data: {}\n\n']), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    let count = 0
    const teed = teeForUsage(
      upstream,
      {
        feed: () => {},
        finish: () => {
          throw new Error('boom')
        },
      } satisfies UsageExtractor,
      () => {
        count++
      },
    )
    await teed.text()
    await new Promise((r) => setTimeout(r, 0))
    expect(count).toBe(1)
  })
})

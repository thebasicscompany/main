import { describe, expect, it } from 'vitest'
import {
  AnthropicSseUsageExtractor,
  extractFromAnthropicJson,
} from './anthropic.js'
import {
  OpenAiSseUsageExtractor,
  extractFromOpenAiJson,
} from './openai.js'
import {
  GoogleStreamUsageExtractor,
  extractFromGoogleJson,
} from './google.js'

describe('AnthropicSseUsageExtractor', () => {
  it('captures input + output tokens across message_start / message_delta', () => {
    const x = new AnthropicSseUsageExtractor()
    x.feed(
      'event: message_start\n' +
        'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
    )
    x.feed('event: content_block_start\ndata: {"type":"content_block_start"}\n\n')
    x.feed(
      'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":17}}\n\n',
    )
    const u = x.finish()
    expect(u).toEqual({ model: 'claude-sonnet-4-5', inputTokens: 42, outputTokens: 17 })
  })

  it('captures cache read + creation tokens when present', () => {
    const x = new AnthropicSseUsageExtractor()
    x.feed(
      'event: message_start\n' +
        'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":12,"cache_read_input_tokens":300,"cache_creation_input_tokens":50,"output_tokens":1}}}\n\n',
    )
    x.feed(
      'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":42}}\n\n',
    )
    const u = x.finish()
    expect(u?.inputTokens).toBe(12)
    expect(u?.outputTokens).toBe(42)
    expect(u?.cacheReadInputTokens).toBe(300)
    expect(u?.cacheCreationInputTokens).toBe(50)
  })

  it('handles SSE chunks split across feed() calls', () => {
    const x = new AnthropicSseUsageExtractor()
    const full =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":3}}\n\n'
    // Split mid-event
    for (const chunk of [full.slice(0, 30), full.slice(30, 90), full.slice(90)]) {
      x.feed(chunk)
    }
    const u = x.finish()
    expect(u?.inputTokens).toBe(7)
    expect(u?.outputTokens).toBe(3)
  })

  it('returns null when no SSE events were seen', () => {
    expect(new AnthropicSseUsageExtractor().finish()).toBeNull()
  })

  it('skips malformed data lines without throwing', () => {
    const x = new AnthropicSseUsageExtractor()
    x.feed('event: message_start\ndata: {not json}\n\n')
    x.feed(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    )
    expect(x.finish()?.inputTokens).toBe(5)
  })
})

describe('extractFromAnthropicJson', () => {
  it('returns input/output/cache from a complete body', () => {
    const u = extractFromAnthropicJson({
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 14,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })
    expect(u).toEqual({ model: 'claude-sonnet-4-5', inputTokens: 14, outputTokens: 5 })
  })
  it('returns null when usage is missing', () => {
    expect(extractFromAnthropicJson({ model: 'x' })).toBeNull()
    expect(extractFromAnthropicJson(null)).toBeNull()
  })
})

describe('OpenAiSseUsageExtractor', () => {
  it('captures usage from the final include_usage chunk', () => {
    const x = new OpenAiSseUsageExtractor()
    x.feed('data: {"choices":[{"delta":{"content":"hi"}}],"model":"gpt-5"}\n\n')
    x.feed(
      'data: {"choices":[],"model":"gpt-5","usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n',
    )
    x.feed('data: [DONE]\n\n')
    const u = x.finish()
    expect(u).toEqual({ model: 'gpt-5', inputTokens: 11, outputTokens: 4 })
  })

  it('returns null when client did not request include_usage', () => {
    const x = new OpenAiSseUsageExtractor()
    x.feed('data: {"choices":[{"delta":{"content":"hi"}}],"model":"gpt-5"}\n\n')
    x.feed('data: [DONE]\n\n')
    expect(x.finish()).toBeNull()
  })
})

describe('extractFromOpenAiJson', () => {
  it('reads prompt/completion tokens', () => {
    expect(
      extractFromOpenAiJson({
        model: 'gpt-5',
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      }),
    ).toEqual({ model: 'gpt-5', inputTokens: 9, outputTokens: 3 })
  })
})

describe('GoogleStreamUsageExtractor', () => {
  it('keeps highest token counts seen across SSE chunks', () => {
    const x = new GoogleStreamUsageExtractor()
    x.feed(
      'data: {"modelVersion":"gemini-2.5-flash","candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":2}}\n\n',
    )
    x.feed(
      'data: {"modelVersion":"gemini-2.5-flash","candidates":[{"content":{"parts":[{"text":"there"}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7}}\n\n',
    )
    const u = x.finish()
    expect(u).toEqual({ model: 'gemini-2.5-flash', inputTokens: 12, outputTokens: 7 })
  })
})

describe('extractFromGoogleJson', () => {
  it('reads prompt/candidates token counts', () => {
    expect(
      extractFromGoogleJson({
        modelVersion: 'gemini-2.5-flash',
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      }),
    ).toEqual({ model: 'gemini-2.5-flash', inputTokens: 4, outputTokens: 2 })
  })
})

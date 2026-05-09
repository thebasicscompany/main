import { describe, expect, it } from 'vitest'
import { GoogleChatCompleteStreamChunkTransform } from './chatComplete.js'

describe('GoogleChatCompleteStreamChunkTransform', () => {
  it('ignores Gemini stream closing array chunks', () => {
    expect(
      GoogleChatCompleteStreamChunkTransform(']', 'google-test', {}, true),
    ).toBe('')
  })

  it('maps Gemini stream chunks to OpenAI-compatible SSE chunks', () => {
    const out = GoogleChatCompleteStreamChunkTransform(
      '[{"candidates":[{"content":{"parts":[{"text":"papaya"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":2,"totalTokenCount":25},"modelVersion":"gemini-2.5-flash"}',
      'google-test',
      {},
      true,
    )

    expect(out).toContain('data: ')
    expect(out).toContain('"provider":"google"')
    expect(out).toContain('"content":"papaya"')
    expect(out).toContain('"prompt_tokens":6')
  })
})

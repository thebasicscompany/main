/**
 * OpenAI SSE usage extractor.
 *
 * For OpenAI Chat Completions streaming, usage is only present when the
 * client sets `stream_options.include_usage: true`. In that case the final
 * chunk before `data: [DONE]` carries:
 *   data: { "choices": [], "usage": { "prompt_tokens": N, "completion_tokens": N, "total_tokens": N }, "model": "..." }
 *
 * Non-streaming responses always include usage on the body.
 *
 * If the client did not enable usage, `finish()` returns null.
 */
import type { ExtractedUsage, UsageExtractor } from './types.js'

type OpenAiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export class OpenAiSseUsageExtractor implements UsageExtractor {
  private buffer = ''
  private model: string | null = null
  private input = 0
  private output = 0
  private got = false

  feed(chunk: string): void {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      this.handleBlock(block)
    }
  }

  private handleBlock(block: string): void {
    const lines = block.split('\n')
    let payload = ''
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const v = line.slice(5).replace(/^\s/, '')
        if (v === '[DONE]') return
        payload += payload ? '\n' + v : v
      }
    }
    if (!payload) return
    let parsed: { model?: string; usage?: OpenAiUsage } | undefined
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (!parsed) return
    if (parsed.model && !this.model) this.model = parsed.model
    if (parsed.usage) {
      if (typeof parsed.usage.prompt_tokens === 'number')
        this.input = parsed.usage.prompt_tokens
      if (typeof parsed.usage.completion_tokens === 'number')
        this.output = parsed.usage.completion_tokens
      this.got = true
    }
  }

  finish(): ExtractedUsage | null {
    if (!this.got) return null
    return { model: this.model, inputTokens: this.input, outputTokens: this.output }
  }
}

/**
 * Extract usage from a non-streaming OpenAI JSON body
 * (chat.completions or responses).
 */
export function extractFromOpenAiJson(body: unknown): ExtractedUsage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { model?: string; usage?: OpenAiUsage }
  if (!b.usage) return null
  return {
    model: typeof b.model === 'string' ? b.model : null,
    inputTokens: b.usage.prompt_tokens ?? 0,
    outputTokens: b.usage.completion_tokens ?? 0,
  }
}

/**
 * Native Anthropic SSE usage extractor.
 *
 * Anthropic's `/v1/messages` stream emits SSE events:
 *   event: message_start    data: { message: { model, usage: { input_tokens, cache_*_input_tokens } } }
 *   event: content_block_*  data: { ... }
 *   event: message_delta    data: { delta: { ... }, usage: { output_tokens } }
 *   event: message_stop     data: {}
 *
 * `message_start` carries the prompt-token totals (including cache breakdown);
 * `message_delta` carries the final output_tokens. We accumulate both and
 * emit one `ExtractedUsage` at stream end.
 *
 * Non-streaming requests (`stream: false`) deliver the same payload as a
 * single JSON body — that path is handled by `extractFromJsonBody` rather
 * than this streaming extractor.
 */
import type { ExtractedUsage, UsageExtractor } from './types.js'

type AnthropicMessageStart = {
  type: 'message_start'
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

type AnthropicMessageDelta = {
  type: 'message_delta'
  usage?: {
    output_tokens?: number
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

type AnthropicEvent = AnthropicMessageStart | AnthropicMessageDelta | { type: string }

export class AnthropicSseUsageExtractor implements UsageExtractor {
  private buffer = ''
  private model: string | null = null
  private input = 0
  private output = 0
  private cacheRead = 0
  private cacheCreation = 0
  private sawAny = false

  feed(chunk: string): void {
    this.buffer += chunk
    // SSE events are separated by a blank line — \n\n. Process complete events
    // and keep the trailing partial event in the buffer for the next chunk.
    let idx
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      this.handleBlock(block)
    }
  }

  private handleBlock(block: string): void {
    // An SSE event is one or more `field: value` lines. We only care about `data:`.
    const lines = block.split('\n')
    let dataPayload = ''
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const v = line.slice(5).replace(/^\s/, '')
        dataPayload += dataPayload ? '\n' + v : v
      }
    }
    if (!dataPayload) return
    let parsed: AnthropicEvent
    try {
      parsed = JSON.parse(dataPayload)
    } catch {
      return
    }
    this.sawAny = true
    if (parsed.type === 'message_start') {
      const ms = parsed as AnthropicMessageStart
      const u = ms.message?.usage
      if (ms.message?.model) this.model = ms.message.model
      if (u) {
        if (typeof u.input_tokens === 'number') this.input = u.input_tokens
        if (typeof u.cache_read_input_tokens === 'number')
          this.cacheRead = u.cache_read_input_tokens
        if (typeof u.cache_creation_input_tokens === 'number')
          this.cacheCreation = u.cache_creation_input_tokens
        if (typeof u.output_tokens === 'number') this.output = u.output_tokens
      }
    } else if (parsed.type === 'message_delta') {
      const md = parsed as AnthropicMessageDelta
      const u = md.usage
      if (u) {
        if (typeof u.output_tokens === 'number') this.output = u.output_tokens
        // Anthropic occasionally repeats input/cache in message_delta — only
        // overwrite if non-zero so we don't lose values from message_start.
        if (typeof u.input_tokens === 'number' && u.input_tokens > 0)
          this.input = u.input_tokens
        if (typeof u.cache_read_input_tokens === 'number' && u.cache_read_input_tokens > 0)
          this.cacheRead = u.cache_read_input_tokens
        if (
          typeof u.cache_creation_input_tokens === 'number' &&
          u.cache_creation_input_tokens > 0
        )
          this.cacheCreation = u.cache_creation_input_tokens
      }
    }
  }

  finish(): ExtractedUsage | null {
    if (!this.sawAny) return null
    return {
      model: this.model,
      inputTokens: this.input,
      outputTokens: this.output,
      ...(this.cacheRead > 0 ? { cacheReadInputTokens: this.cacheRead } : {}),
      ...(this.cacheCreation > 0
        ? { cacheCreationInputTokens: this.cacheCreation }
        : {}),
    }
  }
}

/**
 * Extract usage from a non-streaming Anthropic JSON body.
 */
export function extractFromAnthropicJson(body: unknown): ExtractedUsage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  if (!b.usage) return null
  const out: ExtractedUsage = {
    model: typeof b.model === 'string' ? b.model : null,
    inputTokens: b.usage.input_tokens ?? 0,
    outputTokens: b.usage.output_tokens ?? 0,
  }
  if (b.usage.cache_read_input_tokens && b.usage.cache_read_input_tokens > 0) {
    out.cacheReadInputTokens = b.usage.cache_read_input_tokens
  }
  if (
    b.usage.cache_creation_input_tokens &&
    b.usage.cache_creation_input_tokens > 0
  ) {
    out.cacheCreationInputTokens = b.usage.cache_creation_input_tokens
  }
  return out
}

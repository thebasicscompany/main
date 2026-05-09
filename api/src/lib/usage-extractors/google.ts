/**
 * Gemini chunked-JSON usage extractor.
 *
 * Gemini's `streamGenerateContent` emits a stream of JSON objects, each on
 * its own line (with NDJSON-ish delimiters depending on `?alt=sse`). When
 * called with `?alt=sse` the format is SSE, with each chunk:
 *   data: { "candidates": [...], "usageMetadata": { "promptTokenCount": N, "candidatesTokenCount": N } }
 *
 * Without `?alt=sse` the response is a JSON array of these objects.
 *
 * `usageMetadata` typically appears on every chunk (cumulative); we keep
 * the highest values seen so the final state is reported.
 */
import type { ExtractedUsage, UsageExtractor } from './types.js'

type GeminiChunk = {
  modelVersion?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

export class GoogleStreamUsageExtractor implements UsageExtractor {
  private buffer = ''
  private model: string | null = null
  private input = 0
  private output = 0
  private got = false

  feed(chunk: string): void {
    this.buffer += chunk
    // Try SSE-style framing first (\n\n boundaries). Fall back to bracket-
    // delimited JSON arrays for the non-SSE alt= response by scanning for
    // top-level `}\n` boundaries — Gemini formats those as a stream of
    // JSON objects with newlines between them when alt=sse is omitted.
    let idx
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      this.handleSseBlock(block)
    }
  }

  private handleSseBlock(block: string): void {
    const lines = block.split('\n')
    let payload = ''
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const v = line.slice(5).replace(/^\s/, '')
        payload += payload ? '\n' + v : v
      } else if (line.trim().startsWith('{')) {
        // Non-SSE: raw JSON line.
        payload = line.trim()
      }
    }
    if (!payload) return
    let parsed: GeminiChunk | undefined
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (!parsed) return
    if (parsed.modelVersion && !this.model) this.model = parsed.modelVersion
    const u = parsed.usageMetadata
    if (u) {
      if (typeof u.promptTokenCount === 'number' && u.promptTokenCount > this.input) {
        this.input = u.promptTokenCount
      }
      if (
        typeof u.candidatesTokenCount === 'number' &&
        u.candidatesTokenCount > this.output
      ) {
        this.output = u.candidatesTokenCount
      }
      this.got = true
    }
  }

  finish(): ExtractedUsage | null {
    if (!this.got) return null
    return { model: this.model, inputTokens: this.input, outputTokens: this.output }
  }
}

/**
 * Extract usage from a non-streaming Gemini generateContent JSON body.
 */
export function extractFromGoogleJson(body: unknown): ExtractedUsage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as {
    modelVersion?: string
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
    }
  }
  if (!b.usageMetadata) return null
  return {
    model: typeof b.modelVersion === 'string' ? b.modelVersion : null,
    inputTokens: b.usageMetadata.promptTokenCount ?? 0,
    outputTokens: b.usageMetadata.candidatesTokenCount ?? 0,
  }
}

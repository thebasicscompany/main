/**
 * Per-provider usage breakdown extracted from a streaming or non-streaming
 * upstream response. Only fields the provider reports are populated; the
 * tee+meter layer fans out the populated fields into one or more
 * usage_events rows.
 */
export type ExtractedUsage = {
  /** Model name from the upstream response, when available. */
  model: string | null
  /** Plain prompt tokens. */
  inputTokens: number
  /** Generated tokens. */
  outputTokens: number
  /** Anthropic only — billed at 10% of base. */
  cacheReadInputTokens?: number
  /** Anthropic only — billed at 125% of base. */
  cacheCreationInputTokens?: number
}

/**
 * Stateful chunk-or-buffer extractor.
 *
 * Implementations are driven by raw upstream bytes. They MUST NOT modify the
 * bytes — the tee layer pipes them through unchanged.
 *
 *   feed(chunk)   — called for each upstream chunk (text already decoded)
 *   finish()      — called once the stream ends; returns final usage or null
 *
 * Implementations are single-use; create a fresh extractor per request.
 */
export interface UsageExtractor {
  feed(chunk: string): void
  finish(): ExtractedUsage | null
}

export type ProviderKey = 'anthropic' | 'openai' | 'google'

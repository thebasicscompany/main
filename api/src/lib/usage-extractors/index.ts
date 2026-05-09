import { AnthropicSseUsageExtractor, extractFromAnthropicJson } from './anthropic.js'
import { GoogleStreamUsageExtractor, extractFromGoogleJson } from './google.js'
import { OpenAiSseUsageExtractor, extractFromOpenAiJson } from './openai.js'
import type { ExtractedUsage, ProviderKey, UsageExtractor } from './types.js'

export type { ExtractedUsage, ProviderKey, UsageExtractor } from './types.js'

/** Returns a fresh stateful extractor per request. */
export function streamingExtractor(provider: ProviderKey): UsageExtractor {
  switch (provider) {
    case 'anthropic':
      return new AnthropicSseUsageExtractor()
    case 'openai':
      return new OpenAiSseUsageExtractor()
    case 'google':
      return new GoogleStreamUsageExtractor()
  }
}

/** Extract usage from a complete (non-streaming) JSON body for the given provider. */
export function extractFromJson(
  provider: ProviderKey,
  body: unknown,
): ExtractedUsage | null {
  switch (provider) {
    case 'anthropic':
      return extractFromAnthropicJson(body)
    case 'openai':
      return extractFromOpenAiJson(body)
    case 'google':
      return extractFromGoogleJson(body)
  }
}

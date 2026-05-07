/**
 * Thin wrapper around `@anthropic-ai/sdk` for the computer-use agent loop.
 *
 * Responsibilities:
 *  - Lazy client construction (env may not be set at module load).
 *  - Capability gating: throw `AnthropicUnavailableError` if the API key is
 *    missing, mirroring the BrowserbaseUnavailableError pattern in
 *    `lib/browserbase.ts`.
 *  - Uniform `runMessages()` shim that injects the computer-use beta header
 *    via the SDK's per-request `betas` field, mirrors Anthropic's official
 *    computer-use-demo loop pattern (system + tools + ephemeral cache_control
 *    on stable prefix blocks).
 *
 * Phase 03 scope: Anthropic-only. No multi-provider abstraction. Phase 11
 * adds Gemini/OpenAI fallbacks.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getConfig } from '../config.js'
import { AnthropicUnavailableError } from './errors.js'

/**
 * Computer-use-capable Sonnet. Anthropic ships computer-use on a specific
 * subset of models — Sonnet 4.5 is the current canonical. Sonnet 4.6 does
 * NOT accept `computer_20250124` (verified against API: 400 invalid
 * request, "does not support tool types: computer_20250124"). Pin
 * (don't alias) so model upgrades are an explicit code change.
 */
export const COMPUTER_USE_MODEL = 'claude-sonnet-4-5'

/**
 * Beta header for the `computer_20250124` tool revision. The newer Sonnets
 * still gate the v2 computer tool behind this header. Reference:
 * Anthropic computer-use-demo README "Beta Headers" section.
 */
export const COMPUTER_USE_BETA = 'computer-use-2025-01-24'

let _client: Anthropic | null = null

/**
 * Lazy-construct the Anthropic client. Throws `AnthropicUnavailableError`
 * if `ANTHROPIC_API_KEY` is missing — keeps the runtime API bootable in
 * dev/test environments without the key.
 */
export function getAnthropicClient(): Anthropic {
  if (_client) return _client
  const env = getConfig()
  const key = env.ANTHROPIC_API_KEY
  if (!key || key.trim().length === 0) {
    throw new AnthropicUnavailableError()
  }
  _client = new Anthropic({ apiKey: key })
  return _client
}

/** Test-only: reset the cached client so subsequent calls re-read env. */
export function __resetAnthropicClientForTests(client: Anthropic | null = null): void {
  _client = client
}

export interface RunMessagesOptions {
  /** System prompt — plain string; we wrap it in a single ephemeral-cached block. */
  system: string
  /** Conversation messages, role + content blocks. */
  messages: Anthropic.MessageParam[]
  /** Tools array (e.g. computer_20250124 plus any custom tools). */
  tools: Anthropic.Messages.ToolUnion[]
  /** Hard cap on output tokens. Computer-use loops typically run with 4096. */
  maxTokens: number
  /** Optional model override (defaults to `COMPUTER_USE_MODEL`). */
  model?: string
  /** Optional extra beta headers to merge with the computer-use beta. */
  extraBetas?: string[]
}

/**
 * Issue a single Messages request configured for computer-use.
 *
 * Cache strategy follows Anthropic's `computer-use-demo` reference loop:
 *   - The system prompt block carries `cache_control: ephemeral` so the
 *     stable prefix (system + tools, by render order) is cached across
 *     turns.
 *   - The most recent user/tool-result message — the "live edge" of the
 *     conversation — carries a second ephemeral breakpoint so each turn's
 *     prior history is read from cache and only the final block is paid
 *     full-price for.
 *   See `shared/prompt-caching.md` (placement patterns) and
 *   computer-use-demo's loop.py `_inject_prompt_caching` helper for the
 *   pattern.
 *
 * Beta headers ride on the per-request `betas` field exposed by the SDK
 * (`client.beta.messages.create`); this is the SDK's documented mechanism
 * for opt-in betas without polluting the global client config.
 */
export async function runMessages(
  opts: RunMessagesOptions,
): Promise<Anthropic.Messages.Message> {
  const client = getAnthropicClient()

  // System prompt as a single text block with ephemeral cache_control.
  // (Top-level `cache_control: {type: "ephemeral"}` would also work, but the
  // explicit block form gives us symmetry with the message-edge breakpoint
  // and is what the official demo uses.)
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: opts.system,
      cache_control: { type: 'ephemeral' },
    },
  ]

  // Apply the second cache breakpoint to the LAST user/tool-result message.
  // Mirrors computer-use-demo's `_inject_prompt_caching` (loop.py) — only
  // the most recent user turn carries the marker; older breakpoints are
  // left as is so the cache prefix grows turn by turn.
  const messages = applyConversationCacheBreakpoint(opts.messages)

  return client.beta.messages.create({
    model: opts.model ?? COMPUTER_USE_MODEL,
    max_tokens: opts.maxTokens,
    system: systemBlocks,
    tools: opts.tools as Anthropic.Beta.Messages.BetaToolUnion[],
    messages: messages as Anthropic.Beta.Messages.BetaMessageParam[],
    betas: [COMPUTER_USE_BETA, ...(opts.extraBetas ?? [])],
  }) as unknown as Anthropic.Messages.Message
}

/**
 * Tag the LAST user message's last content block with `cache_control:
 * ephemeral` so the conversation prefix up to and including that turn is
 * cached. Mirrors computer-use-demo's `_inject_prompt_caching` (loop.py).
 *
 * Returns a shallow copy — does NOT mutate the input array.
 */
function applyConversationCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages
  const out = messages.slice()

  // Walk backward to find the latest user message (tool_results live there).
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]
    if (!msg || msg.role !== 'user') continue
    if (typeof msg.content === 'string') {
      out[i] = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: msg.content,
            cache_control: { type: 'ephemeral' },
          },
        ],
      }
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const blocks = msg.content.slice()
      const last = blocks[blocks.length - 1]
      if (last) {
        // Re-emit the last block with cache_control attached.
        blocks[blocks.length - 1] = {
          ...last,
          cache_control: { type: 'ephemeral' },
        } as typeof last
      }
      out[i] = { role: 'user', content: blocks }
    }
    break
  }
  return out
}

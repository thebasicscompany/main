/**
 * Wrap a Response so that its body bytes flow through unchanged to the
 * client while a UsageExtractor sees a copy. When the upstream stream
 * finishes (or the body is fully read) we call `onUsage` exactly once with
 * whatever the extractor accumulated.
 *
 * Used by the gateway credential bridge to meter streaming responses
 * without buffering the full body or breaking SSE timing — the
 * TransformStream is zero-copy: each chunk is passed through immediately
 * after the extractor sees it.
 */
import type { ExtractedUsage, UsageExtractor } from './usage-extractors/index.js'

export type UsageCallback = (usage: ExtractedUsage | null) => void | Promise<void>

/**
 * Build a Response whose body tees through `extractor`. The returned
 * Response keeps the same status, headers, and body framing as `upstream`.
 *
 * If `upstream.body` is null (e.g. 204), `onUsage(null)` is invoked
 * immediately and the response is returned as-is.
 */
export function teeForUsage(
  upstream: Response,
  extractor: UsageExtractor,
  onUsage: UsageCallback,
): Response {
  if (!upstream.body) {
    void Promise.resolve(onUsage(null)).catch(() => {})
    return upstream
  }

  const decoder = new TextDecoder('utf-8', { fatal: false })
  let fired = false
  const fire = (): void => {
    if (fired) return
    fired = true
    let usage: ExtractedUsage | null = null
    try {
      usage = extractor.finish()
    } catch {
      usage = null
    }
    void Promise.resolve(onUsage(usage)).catch(() => {})
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        // Decode without consuming UTF-8 sequences; SSE frames may split
        // across chunks but `stream: true` keeps multibyte chars intact.
        const text = decoder.decode(chunk, { stream: true })
        if (text) extractor.feed(text)
      } catch {
        /* extractor failures should not break the passthrough */
      }
      controller.enqueue(chunk)
    },
    flush(_controller) {
      try {
        const tail = decoder.decode()
        if (tail) extractor.feed(tail)
      } catch {
        /* ignore */
      }
      fire()
    },
  })

  const teed = upstream.body.pipeThrough(transform)
  return new Response(teed, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
}

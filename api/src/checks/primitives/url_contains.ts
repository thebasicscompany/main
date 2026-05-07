/**
 * `url_contains` — fetch a URL and assert the response body contains a
 * substring. The simplest non-credentialed check we can ship.
 *
 * v1 implementation:
 *  - Plain `fetch` against the supplied URL.
 *  - 30s timeout via `AbortController` so a hung target doesn't stall the
 *    end-of-run pipeline forever.
 *  - Body is read as text; binary responses produce a failed check with a
 *    `decode_error` reason.
 *  - Evidence captures the URL, status, response time, and a bounded
 *    excerpt of the body so audit consumers can reason about why a check
 *    passed/failed without re-fetching.
 */

import type { CheckContext, CheckFn, CheckResult } from '../types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const EVIDENCE_BODY_EXCERPT_BYTES = 512

export interface UrlContainsParams {
  url: string
  contains: string
  /** Override the 30s default (only useful for tests or known-slow targets). */
  timeoutMs?: number
}

/**
 * Factory: returns a bound `CheckFn` that the runner can invoke without
 * needing to know the params. Each call to `url_contains(...)` in workflow
 * code yields a fresh closure.
 */
export function url_contains(params: UrlContainsParams): CheckFn {
  return async (_ctx: CheckContext): Promise<CheckResult> => {
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()

    try {
      const res = await fetch(params.url, { signal: controller.signal })
      let body: string
      try {
        body = await res.text()
      } catch (decodeErr) {
        return {
          passed: false,
          evidence: {
            url: params.url,
            status: res.status,
            reason: 'decode_error',
            error:
              decodeErr instanceof Error
                ? decodeErr.message
                : String(decodeErr),
            duration_ms: Date.now() - startedAt,
          },
        }
      }

      const passed = body.includes(params.contains)
      return {
        passed,
        evidence: {
          url: params.url,
          contains: params.contains,
          status: res.status,
          duration_ms: Date.now() - startedAt,
          body_excerpt: body.slice(0, EVIDENCE_BODY_EXCERPT_BYTES),
          body_length: body.length,
        },
      }
    } catch (err) {
      // AbortError, network error, DNS failure, etc. all funnel here.
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted/i.test(err.message))
      return {
        passed: false,
        evidence: {
          url: params.url,
          reason: isAbort ? 'timeout' : 'network_error',
          error: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - startedAt,
        },
      }
    } finally {
      clearTimeout(t)
    }
  }
}

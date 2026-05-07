/**
 * url_contains — Phase 06 unit tests.
 *
 * Mocks global `fetch` so we don't hit the network. Three cases:
 *   1. Body contains the substring → passed=true, evidence has body excerpt.
 *   2. Body does not contain → passed=false, evidence still has excerpt.
 *   3. Network error / abort → passed=false, evidence has reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckContext } from '../types.js'
import { url_contains } from './url_contains.js'

const ctx: CheckContext = {
  runId: 'run-test',
  workspaceId: 'ws-test',
  toolCredentials: {},
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('url_contains', () => {
  it('returns passed=true when the body contains the substring', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('<html><body>Example Domain hello</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    const check = url_contains({
      url: 'https://example.com',
      contains: 'Example Domain',
    })
    const result = await check(ctx)
    expect(result.passed).toBe(true)
    const evidence = result.evidence as Record<string, unknown>
    expect(evidence.url).toBe('https://example.com')
    expect(evidence.contains).toBe('Example Domain')
    expect(evidence.status).toBe(200)
    expect(evidence.body_excerpt).toContain('Example Domain')
    expect(typeof evidence.duration_ms).toBe('number')
  })

  it('returns passed=false when the body does not contain the substring', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('<html><body>Different content</body></html>', {
        status: 200,
      })
    }) as typeof fetch

    const check = url_contains({
      url: 'https://example.com',
      contains: 'Example Domain',
    })
    const result = await check(ctx)
    expect(result.passed).toBe(false)
    const evidence = result.evidence as Record<string, unknown>
    expect(evidence.status).toBe(200)
    expect(evidence.body_excerpt).toContain('Different content')
  })

  it('returns passed=false with reason=network_error on fetch throw', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch

    const check = url_contains({
      url: 'https://broken.example',
      contains: 'whatever',
    })
    const result = await check(ctx)
    expect(result.passed).toBe(false)
    const evidence = result.evidence as Record<string, unknown>
    expect(evidence.reason).toBe('network_error')
    expect(evidence.error).toBe('Failed to fetch')
  })

  it('returns passed=false with reason=timeout on AbortError', async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    }) as typeof fetch

    const check = url_contains({
      url: 'https://slow.example',
      contains: 'whatever',
      timeoutMs: 10,
    })
    const result = await check(ctx)
    expect(result.passed).toBe(false)
    const evidence = result.evidence as Record<string, unknown>
    expect(evidence.reason).toBe('timeout')
  })

  it('truncates the body excerpt to the configured cap', async () => {
    const longBody = 'A'.repeat(2000) + 'NEEDLE'
    globalThis.fetch = vi.fn(async () => {
      return new Response(longBody, { status: 200 })
    }) as typeof fetch

    const check = url_contains({
      url: 'https://big.example',
      contains: 'NEEDLE',
    })
    const result = await check(ctx)
    expect(result.passed).toBe(true)
    const evidence = result.evidence as Record<string, unknown>
    expect((evidence.body_excerpt as string).length).toBeLessThanOrEqual(512)
    expect(evidence.body_length).toBe(longBody.length)
  })
})

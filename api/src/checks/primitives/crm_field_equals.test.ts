/**
 * crm_field_equals — Phase 11 unit tests.
 *
 * Mocks `@basics/harness` so we don't need a real CDP session. Each test
 * stubs the helpers the primitive calls (`new_tab`, `wait_for_load`,
 * `wait_for_element`, `js`) with canned outputs and asserts the
 * primitive's evidence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubSession = { sessionId: 'stub-session', targetId: 'tab-1' } as never

const harnessStubs = {
  goto_url: vi.fn(async () => ({})),
  new_tab: vi.fn(async () => 'new-tab-id'),
  wait_for_load: vi.fn(async () => true),
  wait_for_element: vi.fn(async () => true),
  js: vi.fn(async () => 'value'),
  page_info: vi.fn(async () => ({ url: 'https://example.com', title: '', w: 0, h: 0, sx: 0, sy: 0, pw: 0, ph: 0 })),
  wait: vi.fn(async () => undefined),
}

vi.mock('@basics/harness', () => harnessStubs)

beforeEach(() => {
  for (const fn of Object.values(harnessStubs)) {
    fn.mockClear()
  }
  harnessStubs.goto_url.mockResolvedValue({})
  harnessStubs.new_tab.mockResolvedValue('new-tab-id')
  harnessStubs.wait_for_load.mockResolvedValue(true)
  harnessStubs.wait_for_element.mockResolvedValue(true)
  harnessStubs.js.mockResolvedValue('Closed Won')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('crm_field_equals', () => {
  it('returns passed=true when value matches expected (string)', async () => {
    const { crm_field_equals } = await import('./crm_field_equals.js')
    const check = crm_field_equals({
      url: 'https://example.com',
      selector: '#stage',
      expected: 'Closed Won',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(true)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.url).toBe('https://example.com')
    expect(ev.selector).toBe('#stage')
    expect(ev.actual).toBe('Closed Won')
    expect(ev.expected).toBe('Closed Won')
    expect(ev.matched).toBe(true)
    expect(typeof ev.timing_ms).toBe('number')
    expect(harnessStubs.new_tab).toHaveBeenCalledWith(stubSession, 'https://example.com')
  })

  it('returns passed=false with reason=value_mismatch when actual differs', async () => {
    harnessStubs.js.mockResolvedValue('Stage 2')
    const { crm_field_equals } = await import('./crm_field_equals.js')
    const check = crm_field_equals({
      url: 'https://example.com',
      selector: '#stage',
      expected: 'Closed Won',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.actual).toBe('Stage 2')
    expect(ev.matched).toBe(false)
    expect(ev.reason).toBe('value_mismatch')
  })

  it('returns passed=true when value matches expected regex', async () => {
    harnessStubs.js.mockResolvedValue('Q4 2025')
    const { crm_field_equals } = await import('./crm_field_equals.js')
    const check = crm_field_equals({
      url: 'https://example.com',
      selector: '#quarter',
      expected: { regex: '^Q[1-4] 20\\d{2}$' },
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(true)
  })

  it('returns passed=false with reason=selector_not_found on element timeout', async () => {
    harnessStubs.wait_for_element.mockResolvedValue(false)
    const { crm_field_equals } = await import('./crm_field_equals.js')
    const check = crm_field_equals({
      url: 'https://example.com',
      selector: '#missing',
      expected: 'whatever',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('selector_not_found')
  })

  it('returns passed=false with reason=navigation_failed when new_tab throws', async () => {
    harnessStubs.new_tab.mockRejectedValue(new Error('boom'))
    const { crm_field_equals } = await import('./crm_field_equals.js')
    const check = crm_field_equals({
      url: 'https://broken.example',
      selector: '#stage',
      expected: 'whatever',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('navigation_failed')
    expect(ev.error).toBe('boom')
  })

  it('returns passed=false with reason=no_session when session is missing', async () => {
    const { crm_field_equals } = await import('./crm_field_equals.js')
    const check = crm_field_equals({
      url: 'https://example.com',
      selector: '#stage',
      expected: 'Closed Won',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('no_session')
  })
})

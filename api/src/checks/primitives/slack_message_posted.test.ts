/**
 * slack_message_posted — Phase 11 unit tests.
 *
 * Stubs `@basics/harness` so we drive the auth-detection + substring
 * logic without a real session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubSession = { sessionId: 'stub-session', targetId: 'tab-1' } as never

const harnessStubs = {
  new_tab: vi.fn(async () => 'new-tab-id'),
  wait_for_load: vi.fn(async () => true),
  page_info: vi.fn(async () => ({
    url: 'https://app.slack.com/client/T01/C01',
    title: 'Slack',
    w: 0,
    h: 0,
    sx: 0,
    sy: 0,
    pw: 0,
    ph: 0,
  })),
  js: vi.fn(async () => 'Weekly RevOps Digest — pipeline summary'),
  wait: vi.fn(async () => undefined),
}

vi.mock('@basics/harness', () => harnessStubs)

beforeEach(() => {
  for (const fn of Object.values(harnessStubs)) fn.mockClear()
  harnessStubs.new_tab.mockResolvedValue('new-tab-id')
  harnessStubs.wait_for_load.mockResolvedValue(true)
  harnessStubs.page_info.mockResolvedValue({
    url: 'https://app.slack.com/client/T01/C01',
    title: 'Slack',
    w: 0,
    h: 0,
    sx: 0,
    sy: 0,
    pw: 0,
    ph: 0,
  })
  harnessStubs.js.mockResolvedValue('Weekly RevOps Digest — pipeline summary')
  harnessStubs.wait.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('slack_message_posted', () => {
  it('returns passed=true when contains substring is found in body', async () => {
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({
      channel: 'C01',
      contains: 'Weekly RevOps Digest',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(true)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.channel).toBe('C01')
    expect(ev.matched).toBe(true)
    expect(ev.final_url).toContain('app.slack.com')
  })

  it('returns passed=false with reason=substring_not_found', async () => {
    harnessStubs.js.mockResolvedValue('Some other message body')
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({
      channel: 'C01',
      contains: 'Weekly RevOps Digest',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('substring_not_found')
  })

  it('returns passed=false with reason=not_authenticated when bounced to login', async () => {
    harnessStubs.page_info.mockResolvedValue({
      url: 'https://slack.com/signin?redir=...',
      title: 'Sign in to Slack',
      w: 0,
      h: 0,
      sx: 0,
      sy: 0,
      pw: 0,
      ph: 0,
    })
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({
      channel: 'C01',
      contains: 'whatever',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('not_authenticated')
  })

  it('returns passed=true with no contains check when authenticated', async () => {
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({ channel: 'C01' })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(true)
  })

  it('returns passed=false with reason=navigation_failed on new_tab throw', async () => {
    harnessStubs.new_tab.mockRejectedValue(new Error('boom'))
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({ channel: 'C01' })
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

  it('returns no_session when session is missing', async () => {
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({ channel: 'C01' })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('no_session')
  })

  it('caps body excerpt at 1KB', async () => {
    const longBody = 'A'.repeat(2000) + 'NEEDLE'
    harnessStubs.js.mockResolvedValue(longBody)
    const { slack_message_posted } = await import('./slack_message_posted.js')
    const check = slack_message_posted({
      channel: 'C01',
      contains: 'NEEDLE',
    })
    const result = await check({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolCredentials: {},
      session: stubSession,
    })
    const ev = result.evidence as Record<string, unknown>
    expect((ev.body_excerpt as string).length).toBeLessThanOrEqual(1024)
    expect(result.passed).toBe(true)
  })
})

/**
 * record_count_changed — Phase 11 unit tests.
 *
 * Stubs `@basics/harness` and the `runState` / `checkResultsRepo`
 * facades so we can drive baseline lookup without a real DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubSession = { sessionId: 'stub-session', targetId: 'tab-1' } as never

const harnessStubs = {
  new_tab: vi.fn(async () => 'new-tab-id'),
  wait_for_load: vi.fn(async () => true),
  wait_for_element: vi.fn(async () => true),
  js: vi.fn(async () => '42 records'),
}

vi.mock('@basics/harness', () => harnessStubs)

const runStateStub = {
  list: vi.fn(async () => [] as unknown[]),
}

vi.mock('../../orchestrator/runState.js', () => runStateStub)

const checkResultsStub = {
  listForRun: vi.fn(async () => [] as unknown[]),
}

vi.mock('../../orchestrator/checkResultsRepo.js', () => checkResultsStub)

beforeEach(() => {
  for (const fn of Object.values(harnessStubs)) fn.mockClear()
  runStateStub.list.mockReset()
  runStateStub.list.mockResolvedValue([])
  checkResultsStub.listForRun.mockReset()
  checkResultsStub.listForRun.mockResolvedValue([])
  harnessStubs.new_tab.mockResolvedValue('new-tab-id')
  harnessStubs.wait_for_load.mockResolvedValue(true)
  harnessStubs.wait_for_element.mockResolvedValue(true)
  harnessStubs.js.mockResolvedValue('42 records')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('record_count_changed', () => {
  it('first run establishes baseline (passes with baseline_established)', async () => {
    runStateStub.list.mockResolvedValue([])
    const { record_count_changed } = await import('./record_count_changed.js')
    const check = record_count_changed({
      url: 'https://example.com/report',
      selector: '.count',
    })
    const result = await check({
      runId: 'run-current',
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(true)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.count).toBe(42)
    expect(ev.baseline).toBeNull()
    expect(ev.baseline_established).toBe(true)
  })

  it('passes when count increases and expectChange=increase', async () => {
    runStateStub.list.mockResolvedValue([
      {
        runId: 'run-prev',
        workspaceId: 'ws-1',
        workflowId: 'wf-1',
        status: 'verified',
        browserbaseSessionId: 'bb',
        liveUrl: 'live',
        startedAt: new Date().toISOString(),
      },
    ])
    checkResultsStub.listForRun.mockResolvedValue([
      {
        id: 'chk-1',
        runId: 'run-prev',
        checkName: 'record_count_changed',
        passed: true,
        evidence: { count: 30 },
        ranAt: new Date().toISOString(),
      },
    ])

    const { record_count_changed } = await import('./record_count_changed.js')
    const check = record_count_changed({
      url: 'https://example.com/report',
      selector: '.count',
      expectChange: 'increase',
    })
    const result = await check({
      runId: 'run-current',
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(true)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.count).toBe(42)
    expect(ev.baseline).toBe(30)
    expect(ev.delta).toBe(12)
    expect(ev.matched).toBe(true)
  })

  it('fails when count is unchanged and expectChange=increase', async () => {
    runStateStub.list.mockResolvedValue([
      {
        runId: 'run-prev',
        workspaceId: 'ws-1',
        workflowId: 'wf-1',
        status: 'verified',
        browserbaseSessionId: 'bb',
        liveUrl: 'live',
        startedAt: new Date().toISOString(),
      },
    ])
    checkResultsStub.listForRun.mockResolvedValue([
      {
        id: 'chk-1',
        runId: 'run-prev',
        checkName: 'record_count_changed',
        passed: true,
        evidence: { count: 42 },
        ranAt: new Date().toISOString(),
      },
    ])

    const { record_count_changed } = await import('./record_count_changed.js')
    const check = record_count_changed({
      url: 'https://example.com/report',
      selector: '.count',
      expectChange: 'increase',
    })
    const result = await check({
      runId: 'run-current',
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.delta).toBe(0)
    expect(ev.reason).toBe('count_unchanged')
  })

  it('parses comma-grouped numbers correctly', async () => {
    harnessStubs.js.mockResolvedValue('1,234 records')
    const { record_count_changed } = await import('./record_count_changed.js')
    const check = record_count_changed({
      url: 'https://example.com/report',
      selector: '.count',
    })
    const result = await check({
      runId: 'run-current',
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      toolCredentials: {},
      session: stubSession,
    })
    const ev = result.evidence as Record<string, unknown>
    expect(ev.count).toBe(1234)
  })

  it('fails with reason=parse_failed when text has no integer', async () => {
    harnessStubs.js.mockResolvedValue('No records found.')
    const { record_count_changed } = await import('./record_count_changed.js')
    const check = record_count_changed({
      url: 'https://example.com/report',
      selector: '.count',
    })
    const result = await check({
      runId: 'run-current',
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      toolCredentials: {},
      session: stubSession,
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('parse_failed')
  })

  it('returns no_session when session is missing', async () => {
    const { record_count_changed } = await import('./record_count_changed.js')
    const check = record_count_changed({
      url: 'https://example.com/report',
      selector: '.count',
    })
    const result = await check({
      runId: 'run-current',
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      toolCredentials: {},
    })
    expect(result.passed).toBe(false)
    const ev = result.evidence as Record<string, unknown>
    expect(ev.reason).toBe('no_session')
  })
})

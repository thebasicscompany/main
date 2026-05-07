/**
 * Phase 04A pivots `runState` from a process-global Map to a pluggable
 * `RunStateRepo`. These tests target the memory impl (the production
 * Drizzle impl gets exercised end-to-end by integration tests). They
 * also exercise the module-level façade through the test-only
 * `__setRunStateRepoForTests` injector so the public API contract stays
 * pinned regardless of which backing store is wired.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RunAccessDeniedError,
  RunNotFoundError,
} from '../lib/errors.js'
import {
  __resetForTests,
  __setRunStateRepoForTests,
  assertWorkspaceMatch,
  createMemoryRepo,
  get,
  register,
  update,
  type RunRecord,
} from './runState.js'

const baseRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'run-abc',
  workspaceId: 'ws-1',
  workflowId: 'hello-world',
  status: 'running',
  browserbaseSessionId: 'bb-1',
  liveUrl: 'https://browserbase.example/live/1',
  startedAt: '2026-05-06T00:00:00.000Z',
  ...overrides,
})

beforeEach(() => {
  // Force the memory impl for each test so we don't share state across
  // describe blocks and don't accidentally hit the live DB.
  __setRunStateRepoForTests(createMemoryRepo())
})

afterEach(() => {
  __resetForTests()
  __setRunStateRepoForTests(null)
})

describe('runState', () => {
  it('register + get round-trip', async () => {
    const r = baseRecord()
    await register(r)
    expect(await get(r.runId)).toEqual(r)
  })

  it('update merges partial fields', async () => {
    const r = baseRecord()
    await register(r)
    await update(r.runId, {
      status: 'completed',
      completedAt: '2026-05-06T00:01:00.000Z',
    })
    const after = await get(r.runId)
    expect(after.status).toBe('completed')
    expect(after.completedAt).toBe('2026-05-06T00:01:00.000Z')
    expect(after.browserbaseSessionId).toBe('bb-1')
  })

  it('get throws RunNotFoundError for unknown run', async () => {
    await expect(get('missing')).rejects.toBeInstanceOf(RunNotFoundError)
  })

  it('update throws RunNotFoundError for unknown run', async () => {
    await expect(
      update('missing', { status: 'failed' }),
    ).rejects.toBeInstanceOf(RunNotFoundError)
  })

  it('assertWorkspaceMatch returns record on match', async () => {
    const r = baseRecord({ workspaceId: 'ws-allowed' })
    await register(r)
    const result = await assertWorkspaceMatch(r.runId, 'ws-allowed')
    expect(result).toEqual(r)
  })

  it('assertWorkspaceMatch throws RunAccessDeniedError on workspace mismatch', async () => {
    await register(baseRecord({ workspaceId: 'ws-owner' }))
    await expect(
      assertWorkspaceMatch('run-abc', 'ws-other'),
    ).rejects.toBeInstanceOf(RunAccessDeniedError)
  })

  it('assertWorkspaceMatch throws RunNotFoundError when run missing', async () => {
    await expect(
      assertWorkspaceMatch('ghost', 'ws-anything'),
    ).rejects.toBeInstanceOf(RunNotFoundError)
  })
})

describe('RunStateRepo memory impl', () => {
  it('isolated repos do not share state', async () => {
    const a = createMemoryRepo()
    const b = createMemoryRepo()
    await a.register(baseRecord({ runId: 'run-a' }))
    // memory impl is synchronous; wrap the call to capture either a thrown
    // error or a rejected promise.
    expect(() => b.get('run-a')).toThrow(RunNotFoundError)
  })
})

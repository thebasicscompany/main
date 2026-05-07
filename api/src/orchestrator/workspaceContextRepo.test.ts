/**
 * Memory-impl tests for the workspace context repo. Mirrors the pattern in
 * `runState.test.ts` / `approvalsRepo.test.ts` — exercise the exported
 * memory impl directly plus the module-level facade via the test injector.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetForTests,
  __setWorkspaceContextRepoForTests,
  createMemoryRepo,
  getSnapshot,
  markSynced,
  setContextId,
} from './workspaceContextRepo.js'

beforeEach(() => {
  __setWorkspaceContextRepoForTests(createMemoryRepo())
})

afterEach(() => {
  __resetForTests()
  __setWorkspaceContextRepoForTests(null)
})

describe('workspaceContextRepo memory impl', () => {
  it('getSnapshot returns null for an unknown workspace', async () => {
    const snap = await getSnapshot('ws-unknown')
    expect(snap).toBeNull()
  })

  it('setContextId then getSnapshot round-trips the contextId', async () => {
    await setContextId('ws-1', 'bb-ctx-abc')
    const snap = await getSnapshot('ws-1')
    expect(snap).not.toBeNull()
    expect(snap?.contextId).toBe('bb-ctx-abc')
    expect(snap?.lastSyncedAt).toBeNull()
  })

  it('markSynced records the timestamp without clobbering the contextId', async () => {
    await setContextId('ws-2', 'bb-ctx-xyz')
    const ts = new Date('2026-05-07T12:00:00.000Z')
    await markSynced('ws-2', ts)
    const snap = await getSnapshot('ws-2')
    expect(snap?.contextId).toBe('bb-ctx-xyz')
    expect(snap?.lastSyncedAt).toBe(ts.toISOString())
  })

  it('markSynced for a never-set workspace creates a snapshot with a null contextId', async () => {
    // Lens shouldn't ever call markSynced before setContextId, but the repo
    // tolerates it without crashing — useful so a partial-failure recovery
    // doesn't blow up.
    const ts = new Date('2026-05-07T12:30:00.000Z')
    await markSynced('ws-3', ts)
    const snap = await getSnapshot('ws-3')
    expect(snap?.contextId).toBeNull()
    expect(snap?.lastSyncedAt).toBe(ts.toISOString())
  })

  it('setContextId is idempotent on repeated writes — last write wins', async () => {
    await setContextId('ws-4', 'bb-ctx-1')
    await setContextId('ws-4', 'bb-ctx-2')
    const snap = await getSnapshot('ws-4')
    expect(snap?.contextId).toBe('bb-ctx-2')
  })

  it('markSynced bumps the timestamp on each call', async () => {
    await setContextId('ws-5', 'bb-ctx-5')
    const t1 = new Date('2026-05-07T10:00:00.000Z')
    const t2 = new Date('2026-05-07T11:00:00.000Z')
    await markSynced('ws-5', t1)
    await markSynced('ws-5', t2)
    const snap = await getSnapshot('ws-5')
    expect(snap?.lastSyncedAt).toBe(t2.toISOString())
    expect(snap?.contextId).toBe('bb-ctx-5')
  })

  it('memory impl __seed lets tests pre-populate state', async () => {
    const repo = createMemoryRepo()
    repo.__seed('ws-seeded', {
      contextId: 'bb-ctx-seed',
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
    })
    __setWorkspaceContextRepoForTests(repo)
    const snap = await getSnapshot('ws-seeded')
    expect(snap?.contextId).toBe('bb-ctx-seed')
    expect(snap?.lastSyncedAt).toBe('2026-05-01T00:00:00.000Z')
  })

  it('isolates workspaces from each other', async () => {
    await setContextId('ws-a', 'bb-ctx-a')
    await setContextId('ws-b', 'bb-ctx-b')
    const a = await getSnapshot('ws-a')
    const b = await getSnapshot('ws-b')
    expect(a?.contextId).toBe('bb-ctx-a')
    expect(b?.contextId).toBe('bb-ctx-b')
  })
})

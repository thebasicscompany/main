/**
 * Memory impl tests for the approvals repo. Mirrors the pattern in
 * `runState.test.ts` — exercise the exported memory impl directly plus
 * the module-level facade via `__setApprovalRepoForTests`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetForTests,
  __setApprovalRepoForTests,
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  create,
  createMemoryRepo,
  get,
  listPending,
  resolve,
} from './approvalsRepo.js'

beforeEach(() => {
  __setApprovalRepoForTests(createMemoryRepo())
})

afterEach(() => {
  __resetForTests()
  __setApprovalRepoForTests(null)
})

describe('approvalsRepo memory impl', () => {
  it('create + get round-trip', async () => {
    const exp = new Date(Date.now() + 60_000)
    const a = await create({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 10 },
      expiresAt: exp,
    })
    expect(a.status).toBe('pending')
    expect(a.runId).toBe('run-1')
    expect(a.toolName).toBe('computer.left_click')
    expect(a.params).toEqual({ x: 10 })
    expect(a.resolvedAt).toBeNull()

    const got = await get(a.id)
    expect(got).not.toBeNull()
    expect(got!.id).toBe(a.id)
  })

  it('get returns null for unknown id', async () => {
    expect(await get('missing')).toBeNull()
  })

  it('resolve flips pending → approved', async () => {
    const a = await create({
      runId: 'run-2',
      workspaceId: 'ws-1',
      toolName: 'computer.type',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    const after = await resolve(a.id, {
      decision: 'approve',
      resolvedBy: 'user-1',
      resolvedVia: 'overlay',
    })
    expect(after.status).toBe('approved')
    expect(after.resolvedBy).toBe('user-1')
    expect(after.resolvedVia).toBe('overlay')
    expect(after.resolvedAt).not.toBeNull()
  })

  it('resolve flips pending → rejected', async () => {
    const a = await create({
      runId: 'run-3',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    const after = await resolve(a.id, {
      decision: 'reject',
      resolvedVia: 'overlay',
    })
    expect(after.status).toBe('rejected')
  })

  it('resolve on already-resolved approval throws ApprovalAlreadyResolvedError', async () => {
    const a = await create({
      runId: 'run-4',
      workspaceId: 'ws-1',
      toolName: 'computer.type',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    await resolve(a.id, { decision: 'approve', resolvedVia: 'overlay' })
    await expect(
      resolve(a.id, { decision: 'reject', resolvedVia: 'overlay' }),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError)
  })

  it('resolve on unknown approval throws ApprovalNotFoundError', async () => {
    await expect(
      resolve('does-not-exist', {
        decision: 'approve',
        resolvedVia: 'overlay',
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError)
  })

  it('listPending returns only pending rows for a run', async () => {
    const a = await create({
      runId: 'run-5',
      workspaceId: 'ws-1',
      toolName: 'computer.type',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    const b = await create({
      runId: 'run-5',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    // Resolve `a`, leave `b` pending. Also create one for an unrelated run.
    await resolve(a.id, { decision: 'approve', resolvedVia: 'overlay' })
    await create({
      runId: 'run-other',
      workspaceId: 'ws-1',
      toolName: 'computer.type',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })

    const pending = await listPending('run-5')
    expect(pending.map((p) => p.id)).toEqual([b.id])
  })

  it('isolated repos do not share state', async () => {
    const a = createMemoryRepo()
    const b = createMemoryRepo()
    const r = await a.create({
      runId: 'run-x',
      workspaceId: 'ws-1',
      toolName: 'computer.type',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(await b.get(r.id)).toBeNull()
  })

  it('resolve with timeout decision flips pending → timeout', async () => {
    const a = await create({
      runId: 'run-6',
      workspaceId: 'ws-1',
      toolName: 'computer.type',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    const after = await resolve(a.id, {
      decision: 'timeout',
      resolvedVia: 'system',
    })
    expect(after.status).toBe('timeout')
  })
})

/**
 * Trust grants list/get/revoke repo tests — Phase 09.
 *
 * The match-logic axis (`grantMatches`, `findMatching`) is covered by
 * `trustLedger.test.ts`. This file adds list/get/expired-filter coverage
 * that Phase 09's CRUD endpoints rely on. Memory impl only — Drizzle is
 * exercised live in dev and at deploy time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetForTests,
  __setTrustGrantRepoForTests,
  create,
  createMemoryRepo,
  get,
  list,
  revoke,
} from './trustLedger.js'

beforeEach(() => {
  __setTrustGrantRepoForTests(createMemoryRepo())
})

afterEach(() => {
  __resetForTests()
  __setTrustGrantRepoForTests(null)
})

describe('list', () => {
  it('returns empty array when no grants exist', async () => {
    const r = await list({ workspaceId: 'ws-1' })
    expect(r).toEqual([])
  })

  it('returns workspace grants newest first', async () => {
    const a = await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    // Force an asymmetric createdAt window — the memory impl writes
    // `new Date().toISOString()`, which is monotonic across awaits.
    await new Promise((res) => setTimeout(res, 5))
    const b = await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.type',
      scope: 'workspace',
    })

    const r = await list({ workspaceId: 'ws-1' })
    expect(r.map((g) => g.id)).toEqual([b.id, a.id])
  })

  it('isolates by workspace', async () => {
    await create({
      workspaceId: 'ws-A',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await create({
      workspaceId: 'ws-B',
      grantedBy: 'u-2',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const r = await list({ workspaceId: 'ws-A' })
    expect(r).toHaveLength(1)
    expect(r[0]!.workspaceId).toBe('ws-A')
  })

  it('filters by action_pattern (exact match)', async () => {
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.type',
      scope: 'workspace',
    })
    const r = await list({
      workspaceId: 'ws-1',
      actionPattern: 'computer.type',
    })
    expect(r).toHaveLength(1)
    expect(r[0]!.actionPattern).toBe('computer.type')
  })

  it('drops expired grants by default, includes them with includeExpired=true', async () => {
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.live',
      scope: 'workspace',
    })
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.expired',
      scope: 'workspace',
      expiresAt: new Date(Date.now() - 1000),
    })
    const live = await list({ workspaceId: 'ws-1' })
    expect(live.map((g) => g.actionPattern)).toEqual(['computer.live'])

    const all = await list({ workspaceId: 'ws-1', includeExpired: true })
    expect(all.map((g) => g.actionPattern).sort()).toEqual([
      'computer.expired',
      'computer.live',
    ])
  })

  it('keeps revoked grants in the list (history view)', async () => {
    const g = await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await revoke(g.id, 'u-1')

    const r = await list({ workspaceId: 'ws-1' })
    expect(r).toHaveLength(1)
    expect(r[0]!.revokedAt).not.toBeNull()
  })

  it('respects limit + offset', async () => {
    for (let i = 0; i < 5; i++) {
      await create({
        workspaceId: 'ws-1',
        grantedBy: 'u-1',
        actionPattern: `computer.action_${i}`,
        scope: 'workspace',
      })
      await new Promise((res) => setTimeout(res, 1))
    }
    const r = await list({ workspaceId: 'ws-1', limit: 2, offset: 1 })
    expect(r).toHaveLength(2)
  })
})

describe('get', () => {
  it('returns the grant when workspace matches', async () => {
    const g = await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const r = await get('ws-1', g.id)
    expect(r).not.toBeNull()
    expect(r!.id).toBe(g.id)
  })

  it('returns null when workspace does not own the grant', async () => {
    const g = await create({
      workspaceId: 'ws-victim',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const r = await get('ws-attacker', g.id)
    expect(r).toBeNull()
  })

  it('returns null on missing id', async () => {
    const r = await get('ws-1', 'nonexistent')
    expect(r).toBeNull()
  })
})

describe('revoke (idempotency)', () => {
  it('writes revokedAt + revokedBy', async () => {
    const g = await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await revoke(g.id, 'u-2')
    const after = await get('ws-1', g.id)
    expect(after).not.toBeNull()
    expect(after!.revokedAt).not.toBeNull()
    expect(after!.revokedBy).toBe('u-2')
  })

  it('is a no-op on missing id (does not throw)', async () => {
    await expect(revoke('nonexistent', 'u-1')).resolves.toBeUndefined()
  })

  it('second revoke is idempotent: row stays in revoked state', async () => {
    const g = await create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await revoke(g.id, 'u-2')
    const first = await get('ws-1', g.id)
    const firstRevokedAt = first!.revokedAt
    await new Promise((res) => setTimeout(res, 5))
    await revoke(g.id, 'u-3')
    const second = await get('ws-1', g.id)
    expect(second!.revokedAt).not.toBeNull()
    // The latest revoke wins; that's documented as "second-call-wins"
    // (revoke is overwriting, not append-only). Either second is later
    // than first or equal — the contract is "row remains revoked."
    expect(
      new Date(second!.revokedAt!).getTime() >=
        new Date(firstRevokedAt!).getTime(),
    ).toBe(true)
    expect(second!.revokedBy).toBe('u-3')
  })
})

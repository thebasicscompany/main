/**
 * Trust ledger match-logic tests. The interesting surface is `findMatching`:
 * it composes (action_pattern, params_constraint, scope, expiry, revoked)
 * checks. Each describe block isolates one axis.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetForTests,
  __setTrustGrantRepoForTests,
  create,
  createMemoryRepo,
  findMatching,
  grantMatches,
  matchActionPattern,
  matchParamsConstraint,
  matchScope,
  revoke,
} from './trustLedger.js'

beforeEach(() => {
  __setTrustGrantRepoForTests(createMemoryRepo())
})

afterEach(() => {
  __resetForTests()
  __setTrustGrantRepoForTests(null)
})

describe('matchActionPattern', () => {
  it('exact match', () => {
    expect(matchActionPattern('computer.left_click', 'computer.left_click')).toBe(true)
  })
  it('prefix glob with .*', () => {
    expect(matchActionPattern('computer.*', 'computer.left_click')).toBe(true)
    expect(matchActionPattern('computer.*', 'computer.type')).toBe(true)
  })
  it('prefix glob does not match different prefix', () => {
    expect(matchActionPattern('salesforce.*', 'computer.left_click')).toBe(false)
  })
  it('bare * matches anything', () => {
    expect(matchActionPattern('*', 'computer.left_click')).toBe(true)
  })
  it('non-glob, non-equal patterns do not match', () => {
    expect(matchActionPattern('computer', 'computer.left_click')).toBe(false)
  })
})

describe('matchParamsConstraint', () => {
  it('empty constraint matches anything', () => {
    expect(matchParamsConstraint({}, { x: 1, y: 2 })).toBe(true)
    expect(matchParamsConstraint({}, {})).toBe(true)
  })
  it('shallow equality matches', () => {
    expect(matchParamsConstraint({ x: 100 }, { x: 100, y: 200 })).toBe(true)
  })
  it('shallow equality fails on mismatch', () => {
    expect(matchParamsConstraint({ x: 100 }, { x: 99 })).toBe(false)
  })
  it('missing key in params fails', () => {
    expect(matchParamsConstraint({ x: 100 }, { y: 100 })).toBe(false)
  })
  it('all required keys must match', () => {
    expect(matchParamsConstraint({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 })).toBe(true)
    expect(matchParamsConstraint({ a: 1, b: 2 }, { a: 1, b: 99 })).toBe(false)
  })
})

describe('matchScope', () => {
  it('workspace scope always matches', () => {
    expect(matchScope('workspace')).toBe(true)
    expect(matchScope('workspace', 'wf-1')).toBe(true)
  })
  it('workflow:<id> matches when ids match', () => {
    expect(matchScope('workflow:wf-1', 'wf-1')).toBe(true)
  })
  it('workflow:<id> does not match without workflowId', () => {
    expect(matchScope('workflow:wf-1')).toBe(false)
  })
  it('workflow:<id> does not match different workflow', () => {
    expect(matchScope('workflow:wf-1', 'wf-2')).toBe(false)
  })
  it('unknown scope strings do not match', () => {
    expect(matchScope('global', 'wf-1')).toBe(false)
  })
})

describe('grantMatches', () => {
  const baseRec = {
    id: 'g-1',
    workspaceId: 'ws-1',
    grantedBy: 'user-1',
    actionPattern: 'computer.left_click',
    paramsConstraint: {},
    scope: 'workspace',
    expiresAt: null as string | null,
    revokedAt: null as string | null,
    revokedBy: null,
    createdAt: new Date().toISOString(),
  }

  it('matches happy path', () => {
    expect(
      grantMatches(baseRec, {
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: { x: 1 },
      }),
    ).toBe(true)
  })
  it('rejects different workspace', () => {
    expect(
      grantMatches(baseRec, {
        workspaceId: 'ws-other',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBe(false)
  })
  it('rejects when revoked', () => {
    const rec = { ...baseRec, revokedAt: new Date().toISOString() }
    expect(
      grantMatches(rec, {
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBe(false)
  })
  it('rejects when expired', () => {
    const rec = {
      ...baseRec,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    expect(
      grantMatches(rec, {
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBe(false)
  })
  it('matches when expiresAt is in the future', () => {
    const rec = {
      ...baseRec,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    expect(
      grantMatches(rec, {
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBe(true)
  })
})

describe('findMatching (memory facade)', () => {
  it('returns null when no grants exist', async () => {
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBeNull()
  })

  it('finds a matching action_pattern with empty constraint', async () => {
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'user-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const m = await findMatching({
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 1 },
    })
    expect(m).not.toBeNull()
  })

  it('respects params_constraint equality', async () => {
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'user-1',
      actionPattern: 'computer.type',
      paramsConstraint: { text: 'hello' },
      scope: 'workspace',
    })
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.type',
        params: { text: 'world' },
      }),
    ).toBeNull()
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.type',
        params: { text: 'hello' },
      }),
    ).not.toBeNull()
  })

  it('respects workflow scope', async () => {
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'user-1',
      actionPattern: 'computer.*',
      scope: 'workflow:digest',
    })
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
        workflowId: 'other',
      }),
    ).toBeNull()
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
        workflowId: 'digest',
      }),
    ).not.toBeNull()
  })

  it('does not match revoked grants', async () => {
    const g = await create({
      workspaceId: 'ws-1',
      grantedBy: 'user-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await revoke(g.id, 'user-1')
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBeNull()
  })

  it('does not match expired grants', async () => {
    await create({
      workspaceId: 'ws-1',
      grantedBy: 'user-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(
      await findMatching({
        workspaceId: 'ws-1',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBeNull()
  })

  it('isolates by workspace', async () => {
    await create({
      workspaceId: 'ws-A',
      grantedBy: 'user-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    expect(
      await findMatching({
        workspaceId: 'ws-B',
        toolName: 'computer.left_click',
        params: {},
      }),
    ).toBeNull()
  })
})

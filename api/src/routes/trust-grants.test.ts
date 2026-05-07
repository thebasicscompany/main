/**
 * Route tests for /v1/runtime/trust-grants — Phase 09.
 *
 * Covers:
 *   - JWT required on every endpoint
 *   - GET list pagination + action_pattern filter + include_expired
 *   - GET /:id 404 for missing or cross-workspace
 *   - POST happy path + validation
 *   - DELETE happy path + cross-workspace 404 + idempotency
 *   - Round-trips: create-then-list, create-then-revoke-then-list
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
  delete process.env.BROWSERBASE_API_KEY
  delete process.env.BROWSERBASE_PROJECT_ID
})

async function freshApp() {
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
  const trust = await import('../orchestrator/trustLedger.js')
  trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  const { buildApp } = await import('../app.js')
  return buildApp()
}

async function signTestToken(workspaceId = 'ws-test', accountId = 'acct-test') {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: accountId,
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

describe('GET /v1/runtime/trust-grants (list)', () => {
  beforeEach(async () => {
    const trust = await import('../orchestrator/trustLedger.js')
    trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  })

  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/trust-grants')
    expect(res.status).toBe(401)
  })

  it('returns empty list when no grants exist', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/trust-grants', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      grants: unknown[]
      limit: number
      offset: number
      total: number
    }
    expect(body.grants).toEqual([])
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    expect(body.total).toBe(0)
  })

  it('returns this workspace grants only', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await trust.create({
      workspaceId: 'ws-other',
      grantedBy: 'u-2',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const res = await app.request('/v1/runtime/trust-grants', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      grants: Array<{ workspace_id: string }>
    }
    expect(body.grants).toHaveLength(1)
    expect(body.grants[0]!.workspace_id).toBe('ws-1')
  })

  it('filters by action_pattern', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.type',
      scope: 'workspace',
    })
    const res = await app.request(
      '/v1/runtime/trust-grants?action_pattern=computer.type',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      grants: Array<{ action_pattern: string }>
    }
    expect(body.grants).toHaveLength(1)
    expect(body.grants[0]!.action_pattern).toBe('computer.type')
  })

  it('drops expired grants by default; includes them with include_expired=true', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.live',
      scope: 'workspace',
    })
    await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.expired',
      scope: 'workspace',
      expiresAt: new Date(Date.now() - 1000),
    })

    const liveOnly = await app.request('/v1/runtime/trust-grants', {
      headers: { 'X-Workspace-Token': token },
    })
    const liveBody = (await liveOnly.json()) as {
      grants: Array<{ action_pattern: string }>
    }
    expect(liveBody.grants.map((g) => g.action_pattern)).toEqual([
      'computer.live',
    ])

    const all = await app.request(
      '/v1/runtime/trust-grants?include_expired=true',
      { headers: { 'X-Workspace-Token': token } },
    )
    const allBody = (await all.json()) as {
      grants: Array<{ action_pattern: string }>
    }
    expect(allBody.grants.map((g) => g.action_pattern).sort()).toEqual([
      'computer.expired',
      'computer.live',
    ])
  })

  it('respects limit + offset', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    for (let i = 0; i < 5; i++) {
      await trust.create({
        workspaceId: 'ws-1',
        grantedBy: 'u-1',
        actionPattern: `computer.action_${i}`,
        scope: 'workspace',
      })
      await new Promise((res) => setTimeout(res, 1))
    }
    const res = await app.request(
      '/v1/runtime/trust-grants?limit=2&offset=1',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      grants: unknown[]
      limit: number
      offset: number
    }
    expect(body.grants).toHaveLength(2)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(1)
  })

  it('rejects invalid limit (>100)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/trust-grants?limit=500', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /v1/runtime/trust-grants/:id', () => {
  beforeEach(async () => {
    const trust = await import('../orchestrator/trustLedger.js')
    trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  })

  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/trust-grants/some-id')
    expect(res.status).toBe(401)
  })

  it('returns 404 for missing id', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/trust-grants/missing', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('trust_grant_not_found')
  })

  it('returns 404 for cross-workspace grant (existence is privileged)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-attacker')
    const trust = await import('../orchestrator/trustLedger.js')
    const g = await trust.create({
      workspaceId: 'ws-victim',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })

    const res = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
  })

  it('returns the grant on happy path', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    const g = await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const res = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      workspace_id: string
      action_pattern: string
      scope: string
    }
    expect(body.id).toBe(g.id)
    expect(body.workspace_id).toBe('ws-1')
    expect(body.action_pattern).toBe('computer.left_click')
    expect(body.scope).toBe('workspace')
  })
})

describe('POST /v1/runtime/trust-grants', () => {
  beforeEach(async () => {
    const trust = await import('../orchestrator/trustLedger.js')
    trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  })

  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action_pattern: 'computer.left_click',
        scope: 'workspace',
      }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects body missing action_pattern', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ scope: 'workspace' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects invalid scope', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        action_pattern: 'computer.left_click',
        scope: 'global',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('creates a grant and returns 201 with the wire shape', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1', 'acct-creator')
    const res = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        action_pattern: 'computer.left_click',
        scope: 'workspace',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      workspace_id: string
      granted_by: string
      action_pattern: string
      scope: string
      params_constraint: Record<string, unknown>
      revoked_at: string | null
    }
    expect(body.id).toBeTypeOf('string')
    expect(body.workspace_id).toBe('ws-1')
    expect(body.granted_by).toBe('acct-creator')
    expect(body.action_pattern).toBe('computer.left_click')
    expect(body.scope).toBe('workspace')
    expect(body.params_constraint).toEqual({})
    expect(body.revoked_at).toBeNull()
  })

  it('accepts params_constraint and expires_at', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const expiry = new Date(Date.now() + 60_000).toISOString()
    const res = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        action_pattern: 'computer.type',
        scope: 'workflow:digest',
        params_constraint: { text: 'safe-value' },
        expires_at: expiry,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      params_constraint: Record<string, unknown>
      expires_at: string
      scope: string
    }
    expect(body.params_constraint).toEqual({ text: 'safe-value' })
    expect(body.scope).toBe('workflow:digest')
    expect(typeof body.expires_at).toBe('string')
  })

  it('round-trip: created grant appears in subsequent list', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        action_pattern: 'computer.left_click',
        scope: 'workspace',
      }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { id: string }

    const list = await app.request('/v1/runtime/trust-grants', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(list.status).toBe(200)
    const body = (await list.json()) as {
      grants: Array<{ id: string }>
    }
    expect(body.grants.map((g) => g.id)).toContain(created.id)
  })

  it('round-trip: created grant honored by approval middleware', async () => {
    // Sanity-check that POST flows through the same repo gateToolCall reads.
    const app = await freshApp()
    const token = await signTestToken('ws-1', 'acct-creator')
    const res = await app.request('/v1/runtime/trust-grants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        action_pattern: 'computer.left_click',
        scope: 'workspace',
      }),
    })
    expect(res.status).toBe(201)

    const trust = await import('../orchestrator/trustLedger.js')
    const m = await trust.findMatching({
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 100 },
    })
    expect(m).not.toBeNull()
    expect(m!.actionPattern).toBe('computer.left_click')
  })
})

describe('DELETE /v1/runtime/trust-grants/:id', () => {
  beforeEach(async () => {
    const trust = await import('../orchestrator/trustLedger.js')
    trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  })

  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/trust-grants/some-id', {
      method: 'DELETE',
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 for missing id', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/trust-grants/missing', {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 for cross-workspace grant', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-attacker')
    const trust = await import('../orchestrator/trustLedger.js')
    const g = await trust.create({
      workspaceId: 'ws-victim',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const res = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)

    // Victim's grant still active.
    const after = await trust.get('ws-victim', g.id)
    expect(after).not.toBeNull()
    expect(after!.revokedAt).toBeNull()
  })

  it('returns 204 on happy path; revoke flag is set; subsequent match returns null', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1', 'acct-revoker')
    const trust = await import('../orchestrator/trustLedger.js')
    const g = await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })

    const res = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(204)

    const after = await trust.get('ws-1', g.id)
    expect(after).not.toBeNull()
    expect(after!.revokedAt).not.toBeNull()
    expect(after!.revokedBy).toBe('acct-revoker')

    // Approval middleware (gate via findMatching) sees no match.
    const m = await trust.findMatching({
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
    })
    expect(m).toBeNull()
  })

  it('round-trip: create-revoke-list shows the grant in revoked state', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    const g = await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })

    const del = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(del.status).toBe(204)

    const list = await app.request('/v1/runtime/trust-grants', {
      headers: { 'X-Workspace-Token': token },
    })
    const body = (await list.json()) as {
      grants: Array<{ id: string; revoked_at: string | null }>
    }
    const found = body.grants.find((r) => r.id === g.id)
    expect(found).toBeDefined()
    expect(found!.revoked_at).not.toBeNull()
  })

  it('idempotent: second DELETE on the same id still 204', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const trust = await import('../orchestrator/trustLedger.js')
    const g = await trust.create({
      workspaceId: 'ws-1',
      grantedBy: 'u-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })

    const r1 = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(r1.status).toBe(204)

    const r2 = await app.request(`/v1/runtime/trust-grants/${g.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    // Soft-deleted rows still exist for `get` ownership check, so the
    // second DELETE finds the (revoked) row and writes a new revoke
    // timestamp — 204. Documented as "idempotent in spirit."
    expect(r2.status).toBe(204)
  })
})

/**
 * Cron-or-JWT auth middleware tests — Phase 10.5.
 *
 * Coverage:
 *  - workspace JWT path: valid → 200; invalid → 401; missing → falls
 *    through to cron-secret check.
 *  - cron-secret path: header matches RUNTIME_CRON_SECRET → 200 with
 *    cronTrigger=true; header mismatch → 401; header present but server
 *    secret unset → 401.
 *  - precedence: JWT wins over cron secret when both are present.
 *  - 401 when neither header is provided.
 *
 * The middleware is exercised against a tiny throwaway Hono app rather
 * than the full /v1/runtime/workflows route — keeps the assertions
 * focused on the auth path.
 */

import { Hono } from 'hono'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const TEST_CRON_SECRET = 'cron-secret-very-long-please-rotate'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
})

beforeEach(async () => {
  process.env.RUNTIME_CRON_SECRET = TEST_CRON_SECRET
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
})

afterEach(async () => {
  delete process.env.RUNTIME_CRON_SECRET
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
})

async function buildTestApp() {
  const { requireCronOrWorkspaceJwt } = await import('./cronAuth.js')
  const app = new Hono()
  app.post('/protected', requireCronOrWorkspaceJwt, (c) => {
    return c.json({
      ok: true,
      cron: c.get('cronTrigger') === true,
      workspace_id: c.get('workspace')?.workspace_id ?? null,
    })
  })
  return app
}

async function signTestToken(workspaceId = 'ws-cron-test') {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: 'acct-test',
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

describe('requireCronOrWorkspaceJwt — workspace JWT path', () => {
  it('accepts a valid X-Workspace-Token and sets workspace var', async () => {
    const app = await buildTestApp()
    const token = await signTestToken('ws-jwt')
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      cron: boolean
      workspace_id: string | null
    }
    expect(body.ok).toBe(true)
    expect(body.cron).toBe(false)
    expect(body.workspace_id).toBe('ws-jwt')
  })

  it('accepts a valid Authorization: Bearer token', async () => {
    const app = await buildTestApp()
    const token = await signTestToken('ws-jwt-bearer')
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a malformed JWT with 401 (does not fall through to cron)', async () => {
    const app = await buildTestApp()
    const res = await app.request('/protected', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': 'not.a.real.jwt',
        // even with a valid cron secret, JWT failure is final
        'X-Cron-Secret': TEST_CRON_SECRET,
      },
    })
    expect(res.status).toBe(401)
  })
})

describe('requireCronOrWorkspaceJwt — cron secret path', () => {
  it('accepts X-Cron-Secret matching RUNTIME_CRON_SECRET', async () => {
    const app = await buildTestApp()
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'X-Cron-Secret': TEST_CRON_SECRET },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      cron: boolean
      workspace_id: string | null
    }
    expect(body.ok).toBe(true)
    expect(body.cron).toBe(true)
    expect(body.workspace_id).toBeNull()
  })

  it('rejects X-Cron-Secret mismatch with 401', async () => {
    const app = await buildTestApp()
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'wrong-secret-padding-padding' },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_token')
    expect(body.message).toContain('mismatch')
  })

  it('rejects X-Cron-Secret when server has no RUNTIME_CRON_SECRET set', async () => {
    delete process.env.RUNTIME_CRON_SECRET
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await buildTestApp()
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'anything' },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_token')
    expect(body.message).toContain('none configured')
  })
})

describe('requireCronOrWorkspaceJwt — precedence + missing', () => {
  it('returns 401 when neither header is present', async () => {
    const app = await buildTestApp()
    const res = await app.request('/protected', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_token')
    expect(body.message).toContain('Missing workspace token')
  })

  it('JWT wins when both headers are present (cronTrigger=false)', async () => {
    const app = await buildTestApp()
    const token = await signTestToken('ws-both')
    const res = await app.request('/protected', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': token,
        'X-Cron-Secret': TEST_CRON_SECRET,
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cron: boolean
      workspace_id: string | null
    }
    expect(body.cron).toBe(false)
    expect(body.workspace_id).toBe('ws-both')
  })
})

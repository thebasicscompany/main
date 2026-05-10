import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'
const TEST_RUN_ID = '11111111-1111-4111-8111-111111111111'
const TEST_POOL_ID = '22222222-2222-4222-8222-222222222222'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test'
})

beforeEach(() => {
  vi.resetModules()
})

interface ExecCall {
  query: string
  params: unknown[]
}

/**
 * Mocks `../db/index.js` with a scriptable `db.execute(sql)`. Each call
 * returns the next array off `responses`. We capture the rendered SQL and
 * params for assertions.
 */
async function freshApp(responses: unknown[][]) {
  const calls: ExecCall[] = []
  let i = 0
  vi.doMock('../db/index.js', () => ({
    db: {
      execute: vi.fn(async (sqlObj: { queryChunks?: unknown[]; toString?: () => string } | unknown) => {
        const stringified = (() => {
          // drizzle SQL objects expose `queryChunks` (an array of fragments
          // and parameter placeholders). We just stringify for grep-ability.
          try {
            return JSON.stringify(sqlObj)
          } catch {
            return String(sqlObj)
          }
        })()
        calls.push({ query: stringified, params: [] })
        const out = responses[i] ?? []
        i++
        return out
      }),
    },
  }))

  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()

  const { buildApp } = await import('../app.js')
  return { app: buildApp(), calls }
}

async function signTestToken(workspaceId = TEST_WORKSPACE_ID, accountId = TEST_ACCOUNT_ID) {
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

describe('POST /v1/runs/:id/cancel', () => {
  it('rejects without workspace JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/cancel`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('400s on a non-uuid run id', async () => {
    const { app } = await freshApp([])
    const token = await signTestToken()
    const res = await app.request('/v1/runs/not-a-uuid/cancel', {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(400)
  })

  it('404s when the run is not in the calling workspace', async () => {
    // db.execute returns [] for the ownership SELECT.
    const { app, calls } = await freshApp([[]])
    const token = await signTestToken()
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/cancel`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  it('is idempotent on already-terminal runs', async () => {
    const { app, calls } = await freshApp([
      [{ id: TEST_RUN_ID, status: 'completed', account_id: TEST_ACCOUNT_ID }],
    ])
    const token = await signTestToken()
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/cancel`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.cancelled).toBe(false)
    expect(body.runStatus).toBe('completed')
    expect(body.reason).toBe('already_terminal')
    expect(calls).toHaveLength(1)
  })

  it('cancels pre-dispatch when there is no active binding', async () => {
    const { app, calls } = await freshApp([
      // 1. ownership SELECT
      [{ id: TEST_RUN_ID, status: 'pending', account_id: TEST_ACCOUNT_ID }],
      // 2. binding SELECT — empty
      [],
      // 3. UPDATE cloud_runs SET status='cancelled'
      [],
      // 4. INSERT cloud_activity run_cancelled
      [],
    ])
    const token = await signTestToken()
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/cancel`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.cancelled).toBe(true)
    expect(body.runStatus).toBe('cancelled')
    expect(body.via).toBe('pre_dispatch')
    expect(calls).toHaveLength(4)
    const updateCall = calls[2]!.query
    expect(updateCall).toContain('cloud_runs')
    expect(updateCall).toContain('cancelled')
    const insertCall = calls[3]!.query
    expect(insertCall).toContain('cloud_activity')
    expect(insertCall).toContain('run_cancelled')
  })

  it('NOTIFYs the pool when there is an active binding', async () => {
    const { app, calls } = await freshApp([
      // 1. ownership SELECT
      [{ id: TEST_RUN_ID, status: 'running', account_id: TEST_ACCOUNT_ID }],
      // 2. binding SELECT — one active binding
      [{ session_id: 'oc-session-abc', pool_id: TEST_POOL_ID }],
      // 3. pg_notify
      [],
    ])
    const token = await signTestToken()
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/cancel`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.cancelled).toBe(true)
    expect(body.runStatus).toBe('cancelling')
    expect(body.via).toBe('pool_notify')
    expect(body.sessionId).toBe('oc-session-abc')
    expect(body.poolId).toBe(TEST_POOL_ID)
    const notifyCall = calls[2]!.query
    expect(notifyCall).toContain('pg_notify')
    expect(notifyCall).toContain(`pool_${TEST_POOL_ID.replace(/-/g, '_')}`)
    // Drizzle's SQL object stringifies with escaped JSON inside. Look for
    // the escaped form rather than the raw payload string.
    expect(notifyCall).toContain('kind')
    expect(notifyCall).toContain('cancel')
    expect(notifyCall).toContain('oc-session-abc')
  })
})

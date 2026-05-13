import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'
const TEST_RUN_ID = '11111111-1111-4111-8111-111111111111'
const TEST_APPROVAL_ID = '33333333-3333-4333-8333-333333333333'
const RAW_TOKEN = 'rawtoken-xyz-12345'
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex')

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

interface ExecCall { query: string }

async function freshApp(responses: unknown[][]) {
  const calls: ExecCall[] = []
  let i = 0
  vi.doMock('../db/index.js', () => ({
    db: {
      execute: vi.fn(async (sqlObj: unknown) => {
        let stringified: string
        try {
          stringified = JSON.stringify(sqlObj)
        } catch {
          stringified = String(sqlObj)
        }
        calls.push({ query: stringified })
        const out = responses[i] ?? []
        i++
        return out
      }),
    },
  }))
  // Build a minimal app that mounts ONLY the approvals routes, mirroring
  // app.ts's JWT middleware placement. We deliberately avoid `buildApp()`
  // because its transitive imports (cloud-chat → composio-skill-preferences
  // → @basics/shared) trip module resolution in the api's vitest setup.
  const { Hono } = await import('hono')
  const { requireWorkspaceJwt } = await import('../middleware/jwt.js')
  const {
    approvalsRoute,
    workspaceApprovalsRoute,
    runApprovalsRoute,
  } = await import('./approvals.js')
  const app = new Hono()
  app.use('/v1/runs', requireWorkspaceJwt)
  app.use('/v1/runs/*', requireWorkspaceJwt)
  app.route('/v1/runs', runApprovalsRoute)
  app.use('/v1/workspaces', requireWorkspaceJwt)
  app.use('/v1/workspaces/*', requireWorkspaceJwt)
  app.route('/v1/workspaces', workspaceApprovalsRoute)
  app.route('/v1/approvals', approvalsRoute)
  return { app, calls }
}

async function signTestToken(
  workspaceId = TEST_WORKSPACE_ID,
  accountId = TEST_ACCOUNT_ID,
) {
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

function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date()
  return {
    id: TEST_APPROVAL_ID,
    run_id: TEST_RUN_ID,
    workspace_id: TEST_WORKSPACE_ID,
    account_id: TEST_ACCOUNT_ID,
    tool_name: 'send_email',
    tool_call_id: 'tc_1',
    args_preview: { to: ['a@x.com', 'b@x.com'], subject: 'hi' },
    args_hash: 'abc123',
    reason: 'send_email to 2 recipients',
    status: 'pending',
    decided_by: null,
    decided_at: null,
    expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    access_token_hash: TOKEN_HASH,
    created_at: now.toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// GET /v1/approvals/:id
// ---------------------------------------------------------------------------

describe('GET /v1/approvals/:id', () => {
  it('400s on a non-uuid id', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/approvals/not-a-uuid', {})
    expect(res.status).toBe(400)
  })

  it('404s when approval not found', async () => {
    const { app, calls } = await freshApp([[]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  it('401s without JWT or token', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {})
    expect(res.status).toBe(401)
  })

  it('403s when JWT is for a different workspace', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken(OTHER_WORKSPACE_ID) },
    })
    expect(res.status).toBe(403)
  })

  it('200s with JWT for matching workspace; does NOT leak access_token_hash', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.approval as Record<string, unknown>).id).toBe(TEST_APPROVAL_ID)
    expect((body.approval as Record<string, unknown>).access_token_hash).toBeUndefined()
  })

  it('200s with valid signed token (no JWT)', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}?token=${RAW_TOKEN}`, {})
    expect(res.status).toBe(200)
  })

  it('401s with invalid signed token', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}?token=wrong`, {})
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST /v1/approvals/:id
// ---------------------------------------------------------------------------

describe('POST /v1/approvals/:id', () => {
  it('400s on invalid body', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'maybe' }),
    })
    expect(res.status).toBe(400)
  })

  it('401s without auth', async () => {
    const { app } = await freshApp([[pendingRow()]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(401)
  })

  it('409s when already decided', async () => {
    const { app } = await freshApp([[pendingRow({ status: 'approved' })]])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(409)
  })

  it('410s when expired', async () => {
    const { app } = await freshApp([
      [pendingRow({ expires_at: new Date(Date.now() - 60_000).toISOString() })],
    ])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(410)
  })

  it('approves: UPDATE + INSERT approval_granted activity + pg_notify', async () => {
    const { app, calls } = await freshApp([
      [pendingRow()],   // 1. loadApproval
      [],               // 2. UPDATE
      [],               // 3. INSERT cloud_activity
      [],               // 4. pg_notify (no remember)
    ])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.approval as Record<string, unknown>).status).toBe('approved')
    expect(body.notified).toBe(true)
    expect(body.rememberApplied).toBe(false)

    expect(calls).toHaveLength(4)
    expect(calls[1]!.query).toContain('approvals')
    expect(calls[1]!.query.toLowerCase()).toContain('update')
    expect(calls[2]!.query).toContain('cloud_activity')
    expect(calls[2]!.query).toContain('approval_granted')
    expect(calls[3]!.query).toContain('pg_notify')
    // Channel name is hyphens → underscores.
    expect(calls[3]!.query).toContain(
      `approval_${TEST_APPROVAL_ID.replace(/-/g, '_')}`,
    )
  })

  it('denies: emits approval_denied + pg_notify', async () => {
    const { app, calls } = await freshApp([
      [pendingRow()],
      [],
      [],
      [],
    ])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'denied' }),
    })
    expect(res.status).toBe(200)
    expect(calls[2]!.query).toContain('approval_denied')
    expect(calls[3]!.query).toContain('pg_notify')
  })

  it('remember=true + approved + JWT inserts approval_rules', async () => {
    const { app, calls } = await freshApp([
      [pendingRow()],   // 1. loadApproval
      [],               // 2. UPDATE
      [],               // 3. INSERT cloud_activity
      [],               // 4. INSERT approval_rules
      [],               // 5. pg_notify
    ])
    const res = await app.request(`/v1/approvals/${TEST_APPROVAL_ID}`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved', remember: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.rememberApplied).toBe(true)
    expect(calls).toHaveLength(5)
    expect(calls[3]!.query).toContain('approval_rules')
    expect(calls[3]!.query.toLowerCase()).toContain('insert')
    expect(calls[4]!.query).toContain('pg_notify')
  })

  it('remember=true via signed-token (no account) does NOT insert approval_rules', async () => {
    const { app, calls } = await freshApp([
      [pendingRow()],
      [],   // UPDATE
      [],   // INSERT cloud_activity
      [],   // pg_notify (no rule insert in between)
    ])
    const res = await app.request(
      `/v1/approvals/${TEST_APPROVAL_ID}?token=${RAW_TOKEN}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', remember: true }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.rememberApplied).toBe(false)
    expect(calls).toHaveLength(4)
    // No call should reference approval_rules.
    expect(calls.some((c) => c.query.includes('approval_rules'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/workspaces/:wsId/approvals
// ---------------------------------------------------------------------------

describe('GET /v1/workspaces/:wsId/approvals', () => {
  it('401s without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/approvals`, {})
    expect(res.status).toBe(401)
  })

  it('403s when path wsId != JWT workspace_id', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/workspaces/${OTHER_WORKSPACE_ID}/approvals`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(403)
  })

  it('200s with list', async () => {
    const { app, calls } = await freshApp([
      [
        { id: TEST_APPROVAL_ID, run_id: TEST_RUN_ID, status: 'pending', tool_name: 'send_email' },
      ],
    ])
    const res = await app.request(
      `/v1/workspaces/${TEST_WORKSPACE_ID}/approvals?status=pending&limit=10`,
      { headers: { 'X-Workspace-Token': await signTestToken() } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.approvals as unknown[]).length).toBe(1)
    expect(calls[0]!.query).toContain('approvals')
    expect(calls[0]!.query).toContain('pending')
  })
})

// ---------------------------------------------------------------------------
// POST /v1/runs/:runId/approvals/bulk
// ---------------------------------------------------------------------------

describe('POST /v1/runs/:runId/approvals/bulk', () => {
  it('401s without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/approvals/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(401)
  })

  it('404s when run not in workspace', async () => {
    const { app } = await freshApp([[]])
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/approvals/bulk`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(404)
  })

  it('decides every pending approval and NOTIFYs each channel', async () => {
    const A1 = '44444444-4444-4444-8444-444444444441'
    const A2 = '44444444-4444-4444-8444-444444444442'
    const { app, calls } = await freshApp([
      [{ id: TEST_RUN_ID, account_id: TEST_ACCOUNT_ID }],  // ownership SELECT
      [{ id: A1 }, { id: A2 }],                            // pending SELECT
      [], [], [],                                          // approval #1: UPDATE+activity+NOTIFY
      [], [], [],                                          // approval #2: same
    ])
    const res = await app.request(`/v1/runs/${TEST_RUN_ID}/approvals/bulk`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.decided as unknown[]).length).toBe(2)
    expect(body.decision).toBe('approved')

    // 2 ownership/pending SELECTs + 3 ops per approval × 2 = 8 calls.
    expect(calls).toHaveLength(8)
    // Each NOTIFY uses the per-approval channel.
    expect(calls[4]!.query).toContain(`approval_${A1.replace(/-/g, '_')}`)
    expect(calls[7]!.query).toContain(`approval_${A2.replace(/-/g, '_')}`)
  })
})

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'
const TEST_AUTOMATION_ID = '33333333-3333-4333-8333-333333333333'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
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
  const { Hono } = await import('hono')
  const { requireWorkspaceJwt } = await import('../middleware/jwt.js')
  const { automationsRoute } = await import('./automations.js')
  const app = new Hono()
  app.use('/v1/automations', requireWorkspaceJwt)
  app.use('/v1/automations/*', requireWorkspaceJwt)
  app.route('/v1/automations', automationsRoute)
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

function automationRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString()
  return {
    id: TEST_AUTOMATION_ID,
    workspace_id: TEST_WORKSPACE_ID,
    name: 'Test Automation',
    description: 'desc',
    goal: 'do the thing',
    context: null,
    outputs: [],
    triggers: [{ type: 'manual' }],
    approval_policy: null,
    version: 1,
    created_by: TEST_ACCOUNT_ID,
    created_at: now,
    updated_at: now,
    archived_at: null,
    ...overrides,
  }
}

const validCreateBody = {
  name: 'LP Mapping',
  goal: 'Map new portfolio companies to their LPs',
  outputs: [{ channel: 'email', to: 'test@example.com', when: 'on_complete' }],
  triggers: [{ type: 'manual' }],
}

// ─── auth ────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('401s POST without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validCreateBody),
    })
    expect(res.status).toBe(401)
  })

  it('401s GET list without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/automations', {})
    expect(res.status).toBe(401)
  })

  it('401s DELETE without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
})

// ─── validation ──────────────────────────────────────────────────────────

describe('validation', () => {
  it('400s on missing required field (goal)', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'no goal', outputs: [], triggers: [{ type: 'manual' }] }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on invalid trigger type', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bad', goal: 'x',
        triggers: [{ type: 'cosmic_ray' }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on invalid output channel', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bad', goal: 'x',
        outputs: [{ channel: 'fax', to: '+15551234567', when: 'on_complete' }],
        triggers: [{ type: 'manual' }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on bad E.164 SMS recipient', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bad', goal: 'x',
        outputs: [{ channel: 'sms', to: '5551234567', when: 'on_complete' }],
        triggers: [{ type: 'manual' }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on PUT with empty body', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      method: 'PUT',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

// ─── POST /v1/automations ────────────────────────────────────────────────

describe('POST /v1/automations', () => {
  it('creates row + initial automation_versions snapshot', async () => {
    const created = automationRow({ name: 'LP Mapping' })
    const { app, calls } = await freshApp([
      [created],  // INSERT automations RETURNING …
      [],         // INSERT automation_versions
    ])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(validCreateBody),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.automation as Record<string, unknown>).id).toBe(TEST_AUTOMATION_ID)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.query).toContain('automations')
    expect(calls[1]!.query).toContain('automation_versions')
    expect(calls[1]!.query).toContain('1') // version 1
  })
})

// ─── GET /v1/automations ─────────────────────────────────────────────────

describe('GET /v1/automations', () => {
  it('returns active rows by default, excludes archived', async () => {
    const { app, calls } = await freshApp([
      [automationRow(), automationRow({ id: 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })],
    ])
    const res = await app.request('/v1/automations', {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.automations as unknown[]).length).toBe(2)
    expect(calls[0]!.query).toContain('archived_at IS NULL')
  })

  it('includeArchived=true drops the WHERE filter', async () => {
    const { app, calls } = await freshApp([[]])
    const res = await app.request('/v1/automations?includeArchived=true', {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    expect(calls[0]!.query).not.toContain('archived_at IS NULL')
  })
})

// ─── GET /v1/automations/:id ─────────────────────────────────────────────

describe('GET /v1/automations/:id', () => {
  it('returns the row when present and not archived', async () => {
    const { app } = await freshApp([[automationRow()]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
  })

  it('404s on archived', async () => {
    const { app } = await freshApp([
      [automationRow({ archived_at: new Date().toISOString() })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(404)
  })

  it('404s on missing', async () => {
    const { app } = await freshApp([[]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(404)
  })

  it('404s on cross-workspace (loadAutomation filters by ws)', async () => {
    // loadAutomation SELECT WHERE workspace_id = TEST returns empty since
    // the JWT is for OTHER. The SQL itself does the filtering.
    const { app } = await freshApp([[]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      headers: { 'X-Workspace-Token': await signTestToken(OTHER_WORKSPACE_ID) },
    })
    expect(res.status).toBe(404)
  })
})

// ─── PUT /v1/automations/:id (integration: v1→v2 + snapshot) ─────────────

describe('PUT /v1/automations/:id', () => {
  it('snapshots prior version, increments version, returns v2', async () => {
    const v1 = automationRow({ version: 1, name: 'old', goal: 'old goal' })
    const v2 = { ...v1, version: 2, name: 'new', goal: 'new goal' }
    const { app, calls } = await freshApp([
      [v1],  // loadAutomation
      [],    // INSERT automation_versions (snapshot of v1)
      [v2],  // UPDATE automations RETURNING
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      method: 'PUT',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'new', goal: 'new goal' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.automation as Record<string, unknown>).version).toBe(2)
    expect((body.automation as Record<string, unknown>).name).toBe('new')
    expect(calls).toHaveLength(3)
    expect(calls[1]!.query).toContain('automation_versions')
    expect(calls[1]!.query).toContain('ON CONFLICT')
    expect(calls[2]!.query.toLowerCase()).toContain('update')
  })

  it('404s when target is archived', async () => {
    const { app } = await freshApp([
      [automationRow({ archived_at: new Date().toISOString() })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      method: 'PUT',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})

// ─── DELETE /v1/automations/:id ──────────────────────────────────────────

describe('DELETE /v1/automations/:id', () => {
  it('soft-deletes via archived_at', async () => {
    const archivedAt = new Date().toISOString()
    const { app, calls } = await freshApp([
      [automationRow()],
      [{ archived_at: archivedAt }],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.archived_at).toBe(archivedAt)
    expect(calls[1]!.query.toLowerCase()).toContain('update')
    expect(calls[1]!.query).toContain('archived_at')
  })

  it('is idempotent on already-archived', async () => {
    const existing = new Date('2026-01-01').toISOString()
    const { app, calls } = await freshApp([
      [automationRow({ archived_at: existing })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.idempotent).toBe(true)
    expect(body.archived_at).toBe(existing)
    expect(calls).toHaveLength(1)
  })
})

// ─── GET /v1/automations/:id/versions ────────────────────────────────────

describe('GET /v1/automations/:id/versions', () => {
  it('lists version snapshots', async () => {
    const { app } = await freshApp([
      [{ id: TEST_AUTOMATION_ID }],  // ownership check
      [
        { id: 'v1uuid', automation_id: TEST_AUTOMATION_ID, version: 1, snapshot_json: { name: 'v1' }, created_at: 'now' },
        { id: 'v2uuid', automation_id: TEST_AUTOMATION_ID, version: 2, snapshot_json: { name: 'v2' }, created_at: 'now' },
      ],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/versions`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.versions as unknown[]).length).toBe(2)
  })

  it('404s when caller is not the workspace owner', async () => {
    const { app } = await freshApp([[]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/versions`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(404)
  })
})

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the SQS SDK before any imports that touch it (D.3 manual trigger).
const sqsSendMock = vi.fn(async (_cmd: unknown) => ({ MessageId: 'mock-msg-id' }))
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = sqsSendMock },
  SendMessageCommand: class {
    input: unknown
    constructor(input: unknown) { this.input = input }
  },
}))

// D.4 — Mock the trigger-registry so route tests don't hit AWS Scheduler /
// Composio. (Registry has its own unit tests; here we only assert that the
// CRUD handlers CALL the registry with the right shape.)
const reconcileMock = vi.fn(async () => ({ added: [], removed: [], warnings: [] }))
const teardownMock = vi.fn(async () => ({ added: [], removed: [], warnings: [] }))
const loadConnsMock = vi.fn(async () => ({}))
vi.mock('../lib/automation-trigger-registry.js', () => ({
  reconcileTriggers: reconcileMock,
  teardownAllTriggers: teardownMock,
  loadConnectedAccountByToolkit: loadConnsMock,
}))

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
  process.env.RUNS_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/basics-runs.fifo'
})

beforeEach(() => {
  vi.resetModules()
  sqsSendMock.mockClear()
  reconcileMock.mockClear()
  teardownMock.mockClear()
  loadConnsMock.mockClear()
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
      [],    // DELETE approval_rules (migration 0024 invalidation)
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
    expect(calls).toHaveLength(4)
    expect(calls[1]!.query).toContain('automation_versions')
    expect(calls[1]!.query).toContain('ON CONFLICT')
    expect(calls[2]!.query.toLowerCase()).toContain('update')
    // Migration 0024 — DELETE approval_rules after PUT.
    expect(calls[3]!.query).toContain('approval_rules')
    expect(calls[3]!.query.toLowerCase()).toContain('delete')
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

// ─── POST /v1/automations/:id/triggers/:trigger_index/test  (D.8 dry-run) ─

describe('POST /v1/automations/:id/triggers/:trigger_index/test', () => {
  it('401s without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('400s on non-integer trigger_index', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/foo/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('404s on archived automation', async () => {
    const { app } = await freshApp([
      [automationRow({ archived_at: new Date().toISOString() })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('404s when trigger_index out of range', async () => {
    const { app } = await freshApp([
      [automationRow({ triggers: [{ type: 'manual' }] })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/5/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('trigger_index_out_of_range')
  })

  it('gmail composio_webhook → inputs.email (canned default payload)', async () => {
    const { app, calls } = await freshApp([
      [automationRow({
        triggers: [{ type: 'composio_webhook', toolkit: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE' }],
      })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.dispatched).toBe(false)
    expect((body.inputs as Record<string, unknown>).email).toBeDefined()
    // canned default messageId.
    const inputs = body.inputs as { email: { messageId: string } }
    expect(inputs.email.messageId).toBe('msg_dryrun_example')
    // No DB writes beyond the automation lookup.
    expect(calls).toHaveLength(1)
  })

  it('googlesheets composio_webhook → inputs.row (canned default)', async () => {
    const { app } = await freshApp([
      [automationRow({
        triggers: [{ type: 'composio_webhook', toolkit: 'googlesheets', event: 'GOOGLESHEETS_NEW_ROW' }],
      })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const inputs = body.inputs as { row: Record<string, string> }
    expect(inputs.row.Name).toBe('Acme Capital')
  })

  it('schedule trigger → inputs={}', async () => {
    const { app } = await freshApp([
      [automationRow({
        triggers: [{ type: 'schedule', cron: '0 9 * * MON-FRI', timezone: 'UTC' }],
      })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.inputs).toEqual({})
  })

  it('manual trigger → inputs={}', async () => {
    const { app } = await freshApp([
      [automationRow({ triggers: [{ type: 'manual' }] })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.inputs).toEqual({})
  })

  it('respects user-supplied synthetic_payload', async () => {
    const { app } = await freshApp([
      [automationRow({
        triggers: [{ type: 'composio_webhook', toolkit: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE' }],
      })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ synthetic_payload: { messageId: 'custom_msg', subject: 'Custom subject' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const inputs = body.inputs as { email: { messageId: string; subject: string } }
    expect(inputs.email.messageId).toBe('custom_msg')
    expect(inputs.email.subject).toBe('Custom subject')
  })

  it('never produces an SQS message (no SendMessageCommand)', async () => {
    const { app } = await freshApp([
      [automationRow({ triggers: [{ type: 'manual' }] })],
    ])
    sqsSendMock.mockClear()
    await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/triggers/0/test`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(sqsSendMock).not.toHaveBeenCalled()
  })
})

// ─── POST /v1/automations/:id/run  (D.3 manual trigger) ──────────────────

describe('POST /v1/automations/:id/run', () => {
  it('401s without JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it('404s on missing automation', async () => {
    const { app } = await freshApp([[]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  it('404s on archived automation', async () => {
    const { app } = await freshApp([
      [automationRow({ archived_at: new Date().toISOString() })],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  it('400s on invalid body (inputs is not an object)', async () => {
    const { app } = await freshApp([])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inputs: 'not-an-object' }),
    })
    expect(res.status).toBe(400)
  })

  it('reuses existing ad-hoc cloud_agent, inserts cloud_runs, dispatches to SQS', async () => {
    const { app, calls } = await freshApp([
      [automationRow({ version: 3, goal: 'do the thing' })],  // loadAutomation
      [{ id: 'cag-uuid' }],                                    // SELECT cloud_agents (exists)
      [],                                                       // INSERT cloud_runs
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inputs: { foo: 'bar' } }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.runId).toMatch(/^[0-9a-f]{8}-/)
    expect(body.automationVersion).toBe(3)
    expect(body.triggeredBy).toBe('manual')

    expect(calls).toHaveLength(3)
    expect(calls[2]!.query.toLowerCase()).toContain('insert into')
    expect(calls[2]!.query).toContain('cloud_runs')
    expect(calls[2]!.query).toContain('manual')

    expect(sqsSendMock).toHaveBeenCalledTimes(1)
    const sentInput = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string; MessageGroupId: string } }
    expect(sentInput.input.MessageGroupId).toBe(TEST_WORKSPACE_ID)
    const sentBody = JSON.parse(sentInput.input.MessageBody) as Record<string, unknown>
    expect(sentBody.runId).toBe(body.runId)
    expect(sentBody.workspaceId).toBe(TEST_WORKSPACE_ID)
    expect(sentBody.goal).toBe('do the thing')
    expect(sentBody.automationId).toBe(TEST_AUTOMATION_ID)
    expect(sentBody.automationVersion).toBe(3)
    expect(sentBody.triggeredBy).toBe('manual')
    expect(sentBody.inputs).toEqual({ foo: 'bar' })
  })

  it('creates an ad-hoc cloud_agent when none exists', async () => {
    const { app, calls } = await freshApp([
      [automationRow()],
      [],                       // SELECT cloud_agents — empty
      [{ id: 'newly-created-cag' }],   // INSERT cloud_agents RETURNING
      [],                       // INSERT cloud_runs
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(202)
    expect(calls).toHaveLength(4)
    expect(calls[2]!.query).toContain('cloud_agents')
    expect(calls[2]!.query.toLowerCase()).toContain('insert')
  })

  it('defaults inputs to {} when body omits it', async () => {
    const { app } = await freshApp([
      [automationRow()],
      [{ id: 'cag-uuid' }],
      [],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/run`, {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(202)
    const sentBody = JSON.parse(
      (sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string } }).input.MessageBody,
    ) as Record<string, unknown>
    expect(sentBody.inputs).toEqual({})
  })
})

// ─── E.8 — draft / dry-run / activate ────────────────────────────────────

describe('E.8 — draft status semantics on CREATE', () => {
  it("CREATE defaults status='draft' when body omits it AND does NOT call reconcileTriggers", async () => {
    const { app } = await freshApp([
      [automationRow({ status: 'draft' })], // INSERT
      [], // version snapshot
    ])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validCreateBody,
        triggers: [{ type: 'composio_webhook', toolkit: 'GMAIL', event: 'NEW_THREAD' }],
      }),
    })
    expect(res.status).toBe(201)
    expect(reconcileMock).not.toHaveBeenCalled()
    const body = (await res.json()) as { automation: { status: string } }
    expect(body.automation.status).toBe('draft')
  })

  it("CREATE w/ status='active' DOES call reconcileTriggers", async () => {
    const { app } = await freshApp([
      [automationRow({ status: 'active' })],
      [],
    ])
    const res = await app.request('/v1/automations', {
      method: 'POST',
      headers: {
        'X-Workspace-Token': await signTestToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...validCreateBody, status: 'active' }),
    })
    expect(res.status).toBe(201)
    expect(reconcileMock).toHaveBeenCalledTimes(1)
  })
})

describe('E.8 — POST /:id/activate', () => {
  it('404 on unknown automation', async () => {
    const { app } = await freshApp([[]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/activate`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it("idempotent when status is already 'active' — returns alreadyActive:true and does NOT call reconcileTriggers", async () => {
    const { app } = await freshApp([[automationRow({ status: 'active' })]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/activate`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { alreadyActive: boolean }
    expect(body.alreadyActive).toBe(true)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it("draft → active: UPDATEs status, calls reconcileTriggers", async () => {
    const { app, calls } = await freshApp([
      [automationRow({ status: 'draft' })], // load
      [automationRow({ status: 'active' })], // UPDATE
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/activate`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(reconcileMock).toHaveBeenCalledTimes(1)
    expect(calls[1]!.query.toLowerCase()).toContain('update public.automations')
    expect(calls[1]!.query.toLowerCase()).toContain("set status = 'active'")
  })

  it('409 when automation is archived', async () => {
    const { app } = await freshApp([[automationRow({ status: 'archived', archived_at: new Date().toISOString() })]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/activate`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404) // load returns null for archived rows; that takes precedence
  })
})

describe('E.8 — POST /:id/dry-run', () => {
  it('inserts cloud_runs with dry_run=true + triggered_by=dry_run + dispatches to SQS', async () => {
    const { app, calls } = await freshApp([
      [automationRow({ status: 'draft' })], // load
      [{ id: 'cag-uuid' }], // cloud_agents lookup
      [], // INSERT cloud_runs
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/dry-run`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: { row: { Name: 'Acme' } } }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { dryRun: boolean; triggeredBy: string; previewPollUrl: string; runId: string }
    expect(body.dryRun).toBe(true)
    expect(body.triggeredBy).toBe('dry_run')
    expect(body.previewPollUrl).toMatch(/^\/v1\/runs\/[0-9a-f-]+\/dry-run-preview$/)
    const insertCloudRuns = calls[2]!
    expect(insertCloudRuns.query.toLowerCase()).toContain('insert into public.cloud_runs')
    expect(insertCloudRuns.query).toContain("'dry_run'") // triggered_by literal
    expect(insertCloudRuns.query.toLowerCase()).toContain('true') // dry_run=true literal
    expect(sqsSendMock).toHaveBeenCalledTimes(1)
    const sentBody = JSON.parse(
      (sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string } }).input.MessageBody,
    ) as Record<string, unknown>
    expect(sentBody.dryRun).toBe(true)
    expect(sentBody.triggeredBy).toBe('dry_run')
  })

  it("triggerIndex=0 builds inputs from the trigger's input mapper + synthetic_payload", async () => {
    const automation = automationRow({
      status: 'draft',
      triggers: [{ type: 'composio_webhook', toolkit: 'googlesheets', event: 'NEW_ROW' }],
    })
    const { app } = await freshApp([
      [automation],
      [{ id: 'cag-uuid' }],
      [],
    ])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/dry-run`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: JSON.stringify({
        triggerIndex: 0,
        synthetic_payload: { row: { Name: 'Acme' }, rowNumber: 7 },
      }),
    })
    expect(res.status).toBe(202)
    const sentBody = JSON.parse(
      (sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string } }).input.MessageBody,
    ) as { inputs: Record<string, unknown> }
    // googlesheets mapper picks out row/rowNumber into inputs.
    expect(sentBody.inputs).toBeDefined()
  })

  it('404 on bad trigger index', async () => {
    const automation = automationRow({ status: 'draft', triggers: [{ type: 'manual' }] })
    const { app } = await freshApp([[automation]])
    const res = await app.request(`/v1/automations/${TEST_AUTOMATION_ID}/dry-run`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': await signTestToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ triggerIndex: 5 }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('trigger_index_out_of_range')
  })
})

describe('E.8 — GET /v1/runs/:runId/dry-run-preview', () => {
  async function freshRunsApp(responses: unknown[][]) {
    const calls: Array<{ query: string }> = []
    let i = 0
    vi.doMock('../db/index.js', () => ({
      db: {
        execute: vi.fn(async (sqlObj: unknown) => {
          calls.push({ query: JSON.stringify(sqlObj) })
          const out = responses[i] ?? []
          i++
          return out
        }),
      },
    }))
    const { Hono } = await import('hono')
    const { requireWorkspaceJwt } = await import('../middleware/jwt.js')
    const { dryRunPreviewRoute } = await import('./automations.js')
    const app = new Hono()
    app.use('/v1/runs', requireWorkspaceJwt)
    app.use('/v1/runs/*', requireWorkspaceJwt)
    app.route('/v1/runs', dryRunPreviewRoute)
    return { app, calls }
  }

  const RUN_ID = '44444444-4444-4444-8444-444444444444'

  it('401 without JWT', async () => {
    const { app } = await freshRunsApp([])
    const res = await app.request(`/v1/runs/${RUN_ID}/dry-run-preview`)
    expect(res.status).toBe(401)
  })

  it('400 on bad run id', async () => {
    const { app } = await freshRunsApp([])
    const res = await app.request('/v1/runs/not-a-uuid/dry-run-preview', {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(400)
  })

  it('404 when the run does not exist', async () => {
    const { app } = await freshRunsApp([[]])
    const res = await app.request(`/v1/runs/${RUN_ID}/dry-run-preview`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(404)
  })

  it("404 with error='not_a_dry_run' when the run exists but dry_run=false", async () => {
    const { app } = await freshRunsApp([
      [{ id: RUN_ID, status: 'completed', dry_run: false, dry_run_actions: [], automation_id: null, automation_version: null, triggered_by: 'manual', started_at: null, completed_at: null }],
    ])
    const res = await app.request(`/v1/runs/${RUN_ID}/dry-run-preview`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_a_dry_run')
  })

  it('200 returns dryRunActions + activity stream for a real dry run', async () => {
    const { app } = await freshRunsApp([
      [{
        id: RUN_ID, status: 'completed', dry_run: true,
        dry_run_actions: [{ tool: 'send_sms', args: { to: '+15551234567', body: 'hi' } }],
        automation_id: TEST_AUTOMATION_ID, automation_version: 1, triggered_by: 'dry_run',
        started_at: '2026-05-13T18:00:00Z', completed_at: '2026-05-13T18:00:30Z',
      }],
      [
        { activity_type: 'run_started', payload: {}, created_at: '2026-05-13T18:00:00Z' },
        { activity_type: 'dry_run_action', payload: { tool: 'send_sms' }, created_at: '2026-05-13T18:00:10Z' },
        { activity_type: 'final_answer', payload: { text: '...' }, created_at: '2026-05-13T18:00:25Z' },
        { activity_type: 'run_completed', payload: {}, created_at: '2026-05-13T18:00:30Z' },
      ],
    ])
    const res = await app.request(`/v1/runs/${RUN_ID}/dry-run-preview`, {
      headers: { 'X-Workspace-Token': await signTestToken() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runId: string; status: string; triggeredBy: string; dryRunActions: unknown[]; activity: Array<{ activity_type: string }>
    }
    expect(body.runId).toBe(RUN_ID)
    expect(body.status).toBe('completed')
    expect(body.triggeredBy).toBe('dry_run')
    expect(body.dryRunActions).toHaveLength(1)
    expect(body.activity.map((a) => a.activity_type)).toEqual([
      'run_started', 'dry_run_action', 'final_answer', 'run_completed',
    ])
  })
})

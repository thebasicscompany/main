/**
 * /v1/runtime/routine-imports — Basics Cloud M1.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const WS = 'a0000000-0000-4000-8000-000000000001'
const ACCT = 'b0000000-0000-4000-8000-000000000002'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
})

async function freshApp() {
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
  const workflows = await import('../orchestrator/workflowsRepo.js')
  workflows.__setWorkflowsRepoForTests(workflows.createMemoryRepo())
  const ri = await import('../orchestrator/routineImportsRepo.js')
  ri.__resetRoutineImportsRepoForTests()
  ri.__setRoutineImportsRepoForTests(null)
  const { buildApp } = await import('../app.js')
  return buildApp()
}

async function signTestToken(workspaceId = WS) {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: ACCT,
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

const createBody = {
  assistant_routine_id: 'routine_test_001',
  name: 'Test Import',
  prompt: 'Run the test workflow',
  steps: [],
  parameters: [],
  checks: [],
  artifacts: [
    { kind: 'distill_output' as const, inline_json: { hello: 'world' } },
  ],
}

beforeEach(async () => {
  const workflows = await import('../orchestrator/workflowsRepo.js')
  workflows.__setWorkflowsRepoForTests(workflows.createMemoryRepo())
  const ri = await import('../orchestrator/routineImportsRepo.js')
  ri.__resetRoutineImportsRepoForTests()
  ri.__setRoutineImportsRepoForTests(null)
})

describe('auth', () => {
  it('returns 401 without workspace token on POST /', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /v1/runtime/routine-imports', () => {
  it('returns 201 on first POST with full body', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify(createBody),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { import_id: string; status: string }
    expect(body.status).toBe('importing')
    expect(body.import_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('returns 200 with same import_id on idempotent second POST', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const r1 = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify(createBody),
    })
    expect(r1.status).toBe(201)
    const j1 = (await r1.json()) as { import_id: string }
    const r2 = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify(createBody),
    })
    expect(r2.status).toBe(200)
    const j2 = (await r2.json()) as { import_id: string }
    expect(j2.import_id).toBe(j1.import_id)
  })
})

describe('GET /v1/runtime/routine-imports/:id', () => {
  it('returns 404 for random uuid', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request(
      '/v1/runtime/routine-imports/00000000-0000-4000-8000-00000000dead',
      {
        method: 'GET',
        headers: { 'X-Workspace-Token': token },
      },
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /v1/runtime/routine-imports/:id/promote', () => {
  it('returns 200 with workflow_id and version 1; second promote is 409', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const cr = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify(createBody),
    })
    const { import_id: id } = (await cr.json()) as { import_id: string }

    const p1 = await app.request(`/v1/runtime/routine-imports/${id}/promote`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'Promoted',
        prompt: 'Go',
        steps: [{ a: 1 }],
        parameters: [],
        checks: [{ name: 'url_contains', params: { url: 'https://x.com' } }],
      }),
    })
    expect(p1.status).toBe(200)
    const j1 = (await p1.json()) as {
      workflow_id: string
      version: number
      status: string
    }
    expect(j1.version).toBe(1)
    expect(j1.status).toBe('imported')
    expect(j1.workflow_id).toBeTruthy()

    const p2 = await app.request(`/v1/runtime/routine-imports/${id}/promote`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'Again',
        prompt: 'Nope',
        steps: [],
        parameters: [],
        checks: [],
      }),
    })
    expect(p2.status).toBe(409)
    const err = (await p2.json()) as { error: string }
    expect(err.error).toBe('already_promoted')
  })
})

describe('artifacts', () => {
  it('round-trips inline_json and lists via GET', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const cr = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        ...createBody,
        assistant_routine_id: 'routine_art_1',
        artifacts: [],
      }),
    })
    const { import_id: id } = (await cr.json()) as { import_id: string }

    const post = await app.request(
      `/v1/runtime/routine-imports/${id}/artifacts`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          kind: 'lens_summary',
          inline_json: { steps: [1, 2] },
        }),
      },
    )
    expect(post.status).toBe(200)

    const list = await app.request(
      `/v1/runtime/routine-imports/${id}/artifacts`,
      {
        method: 'GET',
        headers: { 'X-Workspace-Token': token },
      },
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as {
      artifacts: Array<{ kind: string; inline_json: unknown }>
    }
    expect(body.artifacts.length).toBe(1)
    const first = body.artifacts[0]
    expect(first).toBeDefined()
    expect(first!.kind).toBe('lens_summary')
    expect(first!.inline_json).toEqual({ steps: [1, 2] })
  })

  it('presigned mode returns upload_url and storage_url', async () => {
    const s3 = await import('../lib/s3.js')
    const spy = vi.spyOn(s3, 'presignPut').mockResolvedValue({
      uploadUrl: 'https://s3.example/presigned',
      storageUrl: 's3://bucket/workspaces/w/imports/i/f.bin',
    })
    const app = await freshApp()
    const token = await signTestToken()
    const cr = await app.request('/v1/runtime/routine-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        ...createBody,
        assistant_routine_id: 'routine_presign_1',
        artifacts: [],
      }),
    })
    const { import_id: id } = (await cr.json()) as { import_id: string }

    const post = await app.request(
      `/v1/runtime/routine-imports/${id}/artifacts`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          kind: 'screenshot',
          content_type: 'image/png',
          size_bytes: 12345,
        }),
      },
    )
    expect(post.status).toBe(200)
    const body = (await post.json()) as {
      upload_url: string
      storage_url: string
    }
    expect(body.upload_url).toBe('https://s3.example/presigned')
    expect(body.storage_url).toBe('s3://bucket/workspaces/w/imports/i/f.bin')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

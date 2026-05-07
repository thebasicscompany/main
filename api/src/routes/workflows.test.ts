/**
 * /v1/runtime/workflows route tests — Phase 10.
 *
 * Coverage:
 *  - JWT required on every endpoint
 *  - cross-workspace access returns 404
 *  - CRUD happy paths (create, get, list, patch, delete)
 *  - validation errors (missing name/prompt, bad payload)
 *  - run-now happy path (orchestrator startRun mocked via missing
 *    BROWSERBASE_API_KEY — surfaces 503, which is sufficient to prove
 *    the route reaches the orchestrator without booting Browserbase)
 *  - run-now 404 for unknown id, 409 for disabled workflow
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
  const workflows = await import('../orchestrator/workflowsRepo.js')
  workflows.__setWorkflowsRepoForTests(workflows.createMemoryRepo())
  const orchestrator = await import('../orchestrator/runState.js')
  orchestrator.__setRunStateRepoForTests(orchestrator.createMemoryRepo())
  const eventbus = await import('../orchestrator/eventbus.js')
  eventbus.__resetForTests()
  const { buildApp } = await import('../app.js')
  return buildApp()
}

async function signTestToken(workspaceId = 'ws-test') {
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

beforeEach(() => {
  delete process.env.BROWSERBASE_API_KEY
  delete process.env.BROWSERBASE_PROJECT_ID
})

// ---------------------------------------------------------------------------
// Auth coverage.
// ---------------------------------------------------------------------------

describe('JWT required', () => {
  for (const route of [
    { method: 'GET', path: '/v1/runtime/workflows' },
    { method: 'GET', path: '/v1/runtime/workflows/some-id' },
    { method: 'POST', path: '/v1/runtime/workflows' },
    { method: 'PATCH', path: '/v1/runtime/workflows/some-id' },
    { method: 'DELETE', path: '/v1/runtime/workflows/some-id' },
    { method: 'POST', path: '/v1/runtime/workflows/some-id/run-now' },
  ]) {
    it(`${route.method} ${route.path} → 401 without token`, async () => {
      const app = await freshApp()
      const res = await app.request(route.path, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        ...(route.method === 'POST' || route.method === 'PATCH'
          ? { body: JSON.stringify({}) }
          : {}),
      })
      expect(res.status).toBe(401)
    })
  }
})

// ---------------------------------------------------------------------------
// CRUD happy paths + cross-workspace ownership.
// ---------------------------------------------------------------------------

describe('POST /v1/runtime/workflows', () => {
  it('creates a workflow and returns 201', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'Weekly digest',
        prompt: 'Generate the weekly digest.',
        // Phase 10.5: schedule must be a valid AWS EventBridge expression.
        schedule: 'cron(0 9 ? * MON *)',
        // Phase 11: check_modules entries are { name, params }.
        check_modules: [
          {
            name: 'url_contains',
            params: { url: 'https://example.com', contains: 'Example' },
          },
        ],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('Weekly digest')
    expect(body.workspace_id).toBe('ws-1')
    expect(body.schedule).toBe('cron(0 9 ? * MON *)')
    expect(body.check_modules).toEqual([
      {
        name: 'url_contains',
        params: { url: 'https://example.com', contains: 'Example' },
      },
    ])
    expect(body.enabled).toBe(true)
  })

  it('rejects missing fields with 400', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A' }), // missing prompt
    })
    expect(res.status).toBe(400)
  })

  it('rejects check_modules entries that are bare strings (Phase 11 shape)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'A',
        prompt: 'p',
        // Old shape: array of strings. Should be rejected; the new
        // schema requires `{ name, params }` entries.
        check_modules: ['url_contains'],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts check_modules entries with omitted params (defaults to {})', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'A',
        prompt: 'p',
        // Phase 11: params is optional and defaults to {}.
        check_modules: [{ name: 'url_contains' }],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      check_modules: Array<{ name: string; params: Record<string, unknown> }>
    }
    expect(body.check_modules).toEqual([{ name: 'url_contains', params: {} }])
  })

  it('rejects unknown fields with 400 (strict schema)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'A',
        prompt: 'p',
        bogus: 'should be rejected',
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /v1/runtime/workflows/:id', () => {
  it('returns 404 when workflow does not exist', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows/missing', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('workflow_not_found')
  })

  it('returns 404 when workflow belongs to another workspace', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-owner')
    const attackerToken = await signTestToken('ws-attacker')

    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      headers: { 'X-Workspace-Token': attackerToken },
    })
    expect(res.status).toBe(404)
  })

  it('returns the workflow when owned by the calling workspace', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }
    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; id: string }
    expect(body.name).toBe('A')
    expect(body.id).toBe(created.id)
  })
})

describe('GET /v1/runtime/workflows (list)', () => {
  it('lists only the calling workspace, newest first', async () => {
    const app = await freshApp()
    const token1 = await signTestToken('ws-1')
    const token2 = await signTestToken('ws-2')

    for (const name of ['A', 'B']) {
      await app.request('/v1/runtime/workflows', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token1,
        },
        body: JSON.stringify({ name, prompt: 'p' }),
      })
      await new Promise((r) => setTimeout(r, 5))
    }
    await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token2,
      },
      body: JSON.stringify({ name: 'OTHER', prompt: 'p' }),
    })

    const res = await app.request('/v1/runtime/workflows', {
      headers: { 'X-Workspace-Token': token1 },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workflows: Array<{ name: string }>
    }
    expect(body.workflows.map((w) => w.name)).toEqual(['B', 'A'])
  })

  it('filters by ?enabled=false', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')

    const a = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await a.json()) as { id: string }

    // Disable A.
    await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ enabled: false }),
    })

    await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'B', prompt: 'p' }),
    })

    const res = await app.request('/v1/runtime/workflows?enabled=false', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workflows: Array<{ name: string; enabled: boolean }>
    }
    expect(body.workflows.map((w) => w.name)).toEqual(['A'])
    expect(body.workflows[0]!.enabled).toBe(false)
  })
})

describe('PATCH /v1/runtime/workflows/:id', () => {
  it('updates an existing workflow', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        // Phase 10.5: schedule must be a valid AWS EventBridge expression.
        schedule: 'rate(5 minutes)',
        check_modules: [
          {
            name: 'url_contains',
            params: { url: 'https://example.com', contains: 'Example' },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      schedule: string
      check_modules: Array<{ name: string; params: Record<string, unknown> }>
    }
    expect(body.schedule).toBe('rate(5 minutes)')
    expect(body.check_modules).toEqual([
      {
        name: 'url_contains',
        params: { url: 'https://example.com', contains: 'Example' },
      },
    ])
  })

  it('accepts schedule=null to clear', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'A',
        prompt: 'p',
        // Phase 10.5: schedule must be a valid AWS EventBridge expression.
        schedule: 'cron(* * * * ? *)',
      }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ schedule: null }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedule: unknown }
    expect(body.schedule).toBeNull()
  })

  it('rejects empty patch body with 400', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows/some-id', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when workflow belongs to another workspace', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-owner')
    const attackerToken = await signTestToken('ws-attacker')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }
    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': attackerToken,
      },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /v1/runtime/workflows/:id', () => {
  it('hard-deletes and returns 200', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }
    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    // Subsequent GET 404s.
    const after = await app.request(`/v1/runtime/workflows/${created.id}`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(after.status).toBe(404)
  })

  it('returns 404 cross-workspace', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-owner')
    const attackerToken = await signTestToken('ws-attacker')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }
    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': attackerToken },
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// run-now.
//
// We don't have a clean way to mock `startRun` without restructuring the
// orchestrator, so we drive it through the existing 503-on-missing-
// BROWSERBASE_API_KEY path. That proves the route reaches the orchestrator
// (otherwise the 503 wouldn't surface) AND keeps these tests hermetic.
// The earlier 404 / 409 paths run BEFORE the orchestrator is invoked and
// are exercised directly.
// ---------------------------------------------------------------------------

describe('POST /v1/runtime/workflows/:id/run-now', () => {
  it('returns 404 when workflow does not exist', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request(
      '/v1/runtime/workflows/no-such/run-now',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
      },
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('workflow_not_found')
  })

  it('returns 404 cross-workspace', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-owner')
    const attackerToken = await signTestToken('ws-attacker')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }
    const res = await app.request(
      `/v1/runtime/workflows/${created.id}/run-now`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': attackerToken,
        },
      },
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when the workflow is disabled', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p', enabled: false }),
    })
    const created = (await create.json()) as { id: string }
    const res = await app.request(
      `/v1/runtime/workflows/${created.id}/run-now`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: string
      workflow_id: string
    }
    expect(body.error).toBe('workflow_disabled')
    expect(body.workflow_id).toBe(created.id)
  })

  it('reaches the orchestrator on the happy path (503 from missing Browserbase keys proves dispatch)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'do the thing' }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(
      `/v1/runtime/workflows/${created.id}/run-now`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
      },
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('browserbase_unavailable')
  })
})

// ---------------------------------------------------------------------------
// Phase 10.5: cron-secret auth on run-now.
//
// EventBridge calls run-now with X-Cron-Secret instead of a workspace
// JWT. The route resolves workspace_id from the workflow row.
// ---------------------------------------------------------------------------

describe('POST /v1/runtime/workflows/:id/run-now (cron-secret auth)', () => {
  const TEST_CRON_SECRET = 'cron-secret-very-long-please-rotate'

  it('rejects when cron secret is wrong', async () => {
    process.env.RUNTIME_CRON_SECRET = TEST_CRON_SECRET
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await freshApp()

    const res = await app.request(
      '/v1/runtime/workflows/some-id/run-now',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cron-Secret': 'wrong-very-long-padding-padding',
        },
      },
    )
    expect(res.status).toBe(401)
    delete process.env.RUNTIME_CRON_SECRET
    __resetConfigForTests()
  })

  it('rejects when server has no cron secret configured', async () => {
    delete process.env.RUNTIME_CRON_SECRET
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await freshApp()

    const res = await app.request(
      '/v1/runtime/workflows/some-id/run-now',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cron-Secret': 'anything-padding-padding-padding',
        },
      },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when workflow does not exist (cron path)', async () => {
    process.env.RUNTIME_CRON_SECRET = TEST_CRON_SECRET
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await freshApp()

    const res = await app.request(
      '/v1/runtime/workflows/no-such/run-now',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cron-Secret': TEST_CRON_SECRET,
        },
      },
    )
    expect(res.status).toBe(404)
    delete process.env.RUNTIME_CRON_SECRET
    __resetConfigForTests()
  })

  it('returns 409 when the workflow is disabled (cron path)', async () => {
    process.env.RUNTIME_CRON_SECRET = TEST_CRON_SECRET
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-cron-owner')

    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p', enabled: false }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(
      `/v1/runtime/workflows/${created.id}/run-now`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cron-Secret': TEST_CRON_SECRET,
        },
      },
    )
    expect(res.status).toBe(409)
    delete process.env.RUNTIME_CRON_SECRET
    __resetConfigForTests()
  })

  it('reaches orchestrator on cron path and resolves workspace from row (503 from missing Browserbase keys)', async () => {
    process.env.RUNTIME_CRON_SECRET = TEST_CRON_SECRET
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-cron-owner-2')

    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'A', prompt: 'do thing' }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(
      `/v1/runtime/workflows/${created.id}/run-now`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cron-Secret': TEST_CRON_SECRET,
        },
      },
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('browserbase_unavailable')
    delete process.env.RUNTIME_CRON_SECRET
    __resetConfigForTests()
  })
})

// ---------------------------------------------------------------------------
// Phase 10.5: schedule validation at the route layer.
// ---------------------------------------------------------------------------

describe('schedule validation', () => {
  it('rejects bare 5-field cron on create', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'A',
        prompt: 'p',
        schedule: '0 9 * * 1', // bare cron, not wrapped in cron(...)
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects malformed schedule on patch', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const create = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ name: 'A', prompt: 'p' }),
    })
    const created = (await create.json()) as { id: string }

    const res = await app.request(`/v1/runtime/workflows/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ schedule: 'rate(5 fortnights)' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts rate(...) and cron(...) on create', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')

    for (const schedule of [
      'rate(5 minutes)',
      'rate(1 hour)',
      'cron(0 9 ? * MON *)',
      'cron(*/5 * * * ? *)',
    ]) {
      const res = await app.request('/v1/runtime/workflows', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          name: `wf-${schedule}`,
          prompt: 'p',
          schedule,
        }),
      })
      expect(res.status).toBe(201)
    }
  })
})

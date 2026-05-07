/**
 * Route smoke tests for /v1/runtime/runs.
 *
 * Covers:
 *  - POST returns 503 when BROWSERBASE_API_KEY is missing
 *  - POST returns 400 for unknown workflow_id
 *  - GET /:id returns 404 for unknown run
 *  - All endpoints require workspace JWT
 *
 * Does NOT cover the happy path through Browserbase or the SSE stream —
 * those need integration testing (Phase 12).
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
  // BROWSERBASE_API_KEY intentionally NOT set to exercise the 503 path.
  delete process.env.BROWSERBASE_API_KEY
  delete process.env.BROWSERBASE_PROJECT_ID
})

async function freshApp() {
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
  const orchestrator = await import('../orchestrator/runState.js')
  // Wire a fresh memory repo so route handlers and the test's direct
  // `register` calls hit the same store, with no leakage across tests.
  orchestrator.__setRunStateRepoForTests(orchestrator.createMemoryRepo())
  const eventbus = await import('../orchestrator/eventbus.js')
  eventbus.__resetForTests()
  const approvals = await import('../orchestrator/approvalsRepo.js')
  approvals.__setApprovalRepoForTests(approvals.createMemoryRepo())
  const trust = await import('../orchestrator/trustLedger.js')
  trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  const signals = await import('../orchestrator/approvalSignal.js')
  signals.__resetForTests()
  const audit = await import('../orchestrator/auditWriter.js')
  audit.__setRunStepRepoForTests(audit.createMemoryRunStepRepo())
  audit.__setToolCallRepoForTests(audit.createMemoryToolCallRepo())
  const takeover = await import('../orchestrator/takeoverSignal.js')
  takeover.__resetForTests()
  // Phase 10: workflows repo is in-memory under tests so a route-level
  // `workflow_id: '<uuid>'` lookup hits the test-controlled store.
  const workflows = await import('../orchestrator/workflowsRepo.js')
  workflows.__setWorkflowsRepoForTests(workflows.createMemoryRepo())
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

describe('POST /v1/runtime/runs', () => {
  beforeEach(() => {
    delete process.env.BROWSERBASE_API_KEY
    delete process.env.BROWSERBASE_PROJECT_ID
  })

  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_id: 'hello-world' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for unknown workflow_id', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: 'something-else' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('unknown_workflow')
  })

  it('returns 503 when BROWSERBASE_API_KEY missing', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: 'hello-world' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('browserbase_unavailable')
  })
})

describe('GET /v1/runtime/runs/:id', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/runs/some-id')
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown run', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/runs/missing-id', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('run_not_found')
  })

  it('returns the snapshot when run exists and workspace matches', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-owner')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-x',
      workspaceId: 'ws-owner',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb-x',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })

    const res = await app.request('/v1/runtime/runs/run-x', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.run_id).toBe('run-x')
    expect(body.status).toBe('running')
    expect(body.browserbase_session_id).toBe('bb-x')
  })

  it('returns 403 when workspace does not own run', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-attacker')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-y',
      workspaceId: 'ws-victim',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb-y',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })

    const res = await app.request('/v1/runtime/runs/run-y', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /v1/runtime/runs/:id/events', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/runs/x/events')
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown run', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/runs/nope/events', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /v1/runtime/runs/:runId/approvals/:approvalId/resolve', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request(
      '/v1/runtime/runs/run-1/approvals/appr-1/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when run does not exist', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request(
      '/v1/runtime/runs/nope/approvals/appr-1/resolve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when run belongs to a different workspace', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-attacker')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-victim',
      workspaceId: 'ws-victim',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-victim',
      workspaceId: 'ws-victim',
      toolName: 'computer.left_click',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await app.request(
      `/v1/runtime/runs/run-victim/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when approval does not exist for the run', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })

    const res = await app.request(
      '/v1/runtime/runs/run-1/approvals/missing/resolve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when approvalId does not match the runId path segment', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-A',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    await register({
      runId: 'run-B',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-A',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })

    // Hit it under run-B's URL — should 404.
    const res = await app.request(
      `/v1/runtime/runs/run-B/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('approves a pending approval, returns 200, signals the waiter', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 1 },
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await app.request(
      `/v1/runtime/runs/run-1/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; resolved_at: string }
    expect(body.status).toBe('approved')
    expect(body.resolved_at).toBeTypeOf('string')

    const after = await approvals.get(a.id)
    expect(after?.status).toBe('approved')
    expect(after?.resolvedVia).toBe('overlay')
  })

  it('returns 409 when approval is already resolved', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    await approvals.resolve(a.id, {
      decision: 'approve',
      resolvedVia: 'overlay',
    })

    const res = await app.request(
      `/v1/runtime/runs/run-1/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'reject' }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('approval_already_resolved')
  })

  it('returns 409 when approval is already expired', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
      // already expired
      expiresAt: new Date(Date.now() - 1000),
    })

    const res = await app.request(
      `/v1/runtime/runs/run-1/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('approval_expired')

    // Side effect: row was flipped to timeout.
    const after = await approvals.get(a.id)
    expect(after?.status).toBe('timeout')
  })

  it('creates a trust grant when remember=true on approve', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 5 },
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await app.request(
      `/v1/runtime/runs/run-1/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'approve', remember: true }),
      },
    )
    expect(res.status).toBe(200)

    // Ledger should now have one matching grant.
    const trust = await import('../orchestrator/trustLedger.js')
    const m = await trust.findMatching({
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 999 },
    })
    expect(m).not.toBeNull()
    expect(m!.actionPattern).toBe('computer.left_click')
    expect(m!.scope).toBe('workspace')
  })

  it('rejects invalid decision values with 400', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const approvals = await import('../orchestrator/approvalsRepo.js')
    const a = await approvals.create({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: {},
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await app.request(
      `/v1/runtime/runs/run-1/approvals/${a.id}/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ decision: 'maybe' }),
      },
    )
    expect(res.status).toBe(400)
  })
})

// =============================================================================
// Phase 05 — audit-query endpoints.
// =============================================================================

describe('GET /v1/runtime/runs (list) — Phase 05', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/runs')
    expect(res.status).toBe(401)
  })

  it('returns runs for the calling workspace, newest first', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-old',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'completed',
      browserbaseSessionId: 'bb-old',
      liveUrl: 'https://example/live',
      startedAt: '2026-04-01T00:00:00.000Z',
    })
    await register({
      runId: 'run-new',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb-new',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-01T00:00:00.000Z',
    })
    // A run owned by a different workspace must NOT leak into the response.
    await register({
      runId: 'run-other',
      workspaceId: 'ws-other',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb-other',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-02T00:00:00.000Z',
    })

    const res = await app.request('/v1/runtime/runs', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runs: Array<{ run_id: string; status: string }>
    }
    expect(body.runs.map((r) => r.run_id)).toEqual(['run-new', 'run-old'])
  })

  it('filters by status', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'r-a',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-01T00:00:00.000Z',
    })
    await register({
      runId: 'r-b',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'completed',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-02T00:00:00.000Z',
    })

    const res = await app.request('/v1/runtime/runs?status=running', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runs: Array<{ run_id: string; status: string }>
    }
    expect(body.runs.map((r) => r.run_id)).toEqual(['r-a'])
  })

  it('filters by date range', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'r-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'completed',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-04-15T00:00:00.000Z',
    })
    await register({
      runId: 'r-2',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'completed',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-15T00:00:00.000Z',
    })
    const res = await app.request(
      '/v1/runtime/runs?started_after=2026-05-01T00:00:00.000Z',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runs: Array<{ run_id: string }>
    }
    expect(body.runs.map((r) => r.run_id)).toEqual(['r-2'])
  })

  it('respects limit + offset', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    for (let i = 0; i < 5; i++) {
      await register({
        runId: `paged-${i}`,
        workspaceId: 'ws-1',
        workflowId: 'hello-world',
        status: 'completed',
        browserbaseSessionId: 'bb',
        liveUrl: 'https://example/live',
        startedAt: `2026-05-0${i + 1}T00:00:00.000Z`,
      })
    }
    const res = await app.request('/v1/runtime/runs?limit=2&offset=1', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runs: Array<{ run_id: string }>
      limit: number
      offset: number
    }
    expect(body.runs).toHaveLength(2)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(1)
  })

  it('rejects invalid limit (>100)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/runs?limit=500', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /v1/runtime/runs/:id?include=... — Phase 05', () => {
  it('returns steps when ?include=steps is passed', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-incl-1',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const audit = await import('../orchestrator/auditWriter.js')
    await audit.recordStepStart({
      runId: 'run-incl-1',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: { text: 'thinking' },
    })

    const res = await app.request(
      '/v1/runtime/runs/run-incl-1?include=steps',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      steps?: Array<{ kind: string; step_index: number }>
    }
    expect(body.steps).toBeDefined()
    expect(body.steps).toHaveLength(1)
    expect(body.steps![0]!.kind).toBe('model_thinking')
  })

  it('returns tool_calls when ?include=tool_calls is passed', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-incl-2',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const audit = await import('../orchestrator/auditWriter.js')
    const { toolCallId } = await audit.recordToolCallStart({
      runId: 'run-incl-2',
      stepIndex: 0,
      toolName: 'computer.left_click',
      params: { x: 10 },
    })
    await audit.recordToolCallEnd({
      toolCallId,
      result: { content: [] },
      browserLatencyMs: 7,
    })

    const res = await app.request(
      '/v1/runtime/runs/run-incl-2?include=tool_calls',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tool_calls?: Array<{ tool_name: string; browser_latency_ms: number }>
    }
    expect(body.tool_calls).toBeDefined()
    expect(body.tool_calls).toHaveLength(1)
    expect(body.tool_calls![0]!.tool_name).toBe('computer.left_click')
    expect(body.tool_calls![0]!.browser_latency_ms).toBe(7)
  })

  it('returns both when ?include=steps,tool_calls is passed', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-incl-3',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const audit = await import('../orchestrator/auditWriter.js')
    await audit.recordStepStart({
      runId: 'run-incl-3',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: {},
    })
    await audit.recordToolCallStart({
      runId: 'run-incl-3',
      stepIndex: 1,
      toolName: 'computer.screenshot',
      params: {},
    })

    const res = await app.request(
      '/v1/runtime/runs/run-incl-3?include=steps,tool_calls',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      steps?: unknown[]
      tool_calls?: unknown[]
    }
    expect(body.steps).toHaveLength(1)
    expect(body.tool_calls).toHaveLength(1)
  })

  it('omits steps + tool_calls when ?include is absent', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-incl-4',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })

    const res = await app.request('/v1/runtime/runs/run-incl-4', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.steps).toBeUndefined()
    expect(body.tool_calls).toBeUndefined()
  })
})

describe('GET /v1/runtime/runs/:id/tool-calls — Phase 05', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/runs/x/tool-calls')
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown run', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/runs/missing/tool-calls', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
  })

  it('returns 403 when workspace mismatches', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-attacker')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-victim',
      workspaceId: 'ws-victim',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const res = await app.request('/v1/runtime/runs/run-victim/tool-calls', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(403)
  })

  it('returns paginated tool calls for the run', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-tc',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const audit = await import('../orchestrator/auditWriter.js')
    for (let i = 0; i < 3; i++) {
      await audit.recordToolCallStart({
        runId: 'run-tc',
        stepIndex: i,
        toolName: `computer.click_${i}`,
        params: { i },
      })
    }
    const res = await app.request(
      '/v1/runtime/runs/run-tc/tool-calls?limit=2',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tool_calls: Array<{ step_index: number }>
      limit: number
    }
    expect(body.tool_calls).toHaveLength(2)
    expect(body.limit).toBe(2)
  })
})

describe('GET /v1/runtime/runs/:id/steps — Phase 05', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/runs/x/steps')
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown run', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/runs/missing/steps', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(404)
  })

  it('returns paginated steps in stepIndex order', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-steps',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    const audit = await import('../orchestrator/auditWriter.js')
    for (const [i, kind] of [
      [0, 'model_thinking'],
      [1, 'model_tool_use'],
      [2, 'approval'],
    ] as const) {
      await audit.recordStepStart({
        runId: 'run-steps',
        stepIndex: i,
        kind: kind as any,
        payload: { i },
      })
    }
    const res = await app.request('/v1/runtime/runs/run-steps/steps', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      steps: Array<{ kind: string; step_index: number }>
    }
    expect(body.steps.map((s) => s.kind)).toEqual([
      'model_thinking',
      'model_tool_use',
      'approval',
    ])
    expect(body.steps.map((s) => s.step_index)).toEqual([0, 1, 2])
  })
})

// =============================================================================
// Phase 06 — verified/unverified terminal status surfacing.
//
// These tests live at the bottom in their own describe block to minimize
// merge friction with Phase 05's audit-list endpoint additions earlier in
// the file.
// =============================================================================

describe('GET /v1/runtime/runs/:id — Phase 06 terminal statuses', () => {
  it('surfaces status="verified" on the snapshot when a run is verified', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register, update } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-verified',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    await update('run-verified', {
      status: 'verified',
      completedAt: '2026-05-06T00:00:30.000Z',
    })

    const res = await app.request('/v1/runtime/runs/run-verified', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('verified')
    expect(body.completed_at).toBe('2026-05-06T00:00:30.000Z')
  })

  it('surfaces status="unverified" on the snapshot when a check failed', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register, update } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-unverified',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'running',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
    await update('run-unverified', {
      status: 'unverified',
      completedAt: '2026-05-06T00:00:30.000Z',
    })

    const res = await app.request('/v1/runtime/runs/run-unverified', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('unverified')
  })

  it('keeps existing run statuses (running/completed/failed) working', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId: 'run-completed-classic',
      workspaceId: 'ws-1',
      workflowId: 'hello-world',
      status: 'completed',
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })

    const res = await app.request('/v1/runtime/runs/run-completed-classic', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('completed')
  })
})

// =============================================================================
// Phase 08 take-over.
//
// Coverage: auth + ownership, terminal-status 409, happy path takeover →
// resume, double-takeover 409, resume-without-takeover 409.
// =============================================================================

describe('Phase 08 take-over', () => {
  async function registerRunningRun(
    runId: string,
    workspaceId = 'ws-1',
    status: string = 'running',
  ) {
    const { register } = await import('../orchestrator/runState.js')
    await register({
      runId,
      workspaceId,
      workflowId: 'hello-world',
      status: status as any,
      browserbaseSessionId: 'bb',
      liveUrl: 'https://example/live',
      startedAt: '2026-05-06T00:00:00.000Z',
    })
  }

  describe('POST /v1/runtime/runs/:runId/takeover', () => {
    it('requires a workspace token', async () => {
      const app = await freshApp()
      const res = await app.request('/v1/runtime/runs/run-x/takeover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it('returns 404 for unknown run', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      const res = await app.request('/v1/runtime/runs/missing/takeover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
    })

    it('returns 403 when run belongs to a different workspace', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-attacker')
      await registerRunningRun('run-victim', 'ws-victim')

      const res = await app.request('/v1/runtime/runs/run-victim/takeover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it.each([
      ['completed'],
      ['failed'],
      ['verified'],
      ['unverified'],
      ['paused'],
    ])('returns 409 when run is in non-takeover status: %s', async (status) => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      await registerRunningRun(`run-${status}`, 'ws-1', status)

      const res = await app.request(`/v1/runtime/runs/run-${status}/takeover`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; status: string }
      expect(body.error).toBe('takeover_not_allowed')
      expect(body.status).toBe(status)
    })

    it('200 happy path: flips status to paused_by_user, records audit, emits SSE', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      await registerRunningRun('run-1', 'ws-1', 'running')

      const res = await app.request('/v1/runtime/runs/run-1/takeover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ reason: 'agent stuck on the modal' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        status: string
        started_at: string
      }
      expect(body.status).toBe('paused_by_user')
      expect(typeof body.started_at).toBe('string')

      // Run state flipped.
      const { get } = await import('../orchestrator/runState.js')
      const r = await get('run-1')
      expect(r.status).toBe('paused_by_user')

      // Takeover flag is set.
      const { isTakeoverActive } = await import(
        '../orchestrator/takeoverSignal.js'
      )
      expect(isTakeoverActive('run-1')).toBe(true)

      // Audit step persisted.
      const audit = await import('../orchestrator/auditWriter.js')
      const steps = await audit.listRunSteps('run-1')
      const takeoverStep = steps.find((s) => s.kind === 'user_takeover')
      expect(takeoverStep).toBeDefined()
      expect((takeoverStep!.payload as Record<string, unknown>).phase).toBe(
        'started',
      )
      expect(
        (takeoverStep!.payload as Record<string, unknown>).account_id,
      ).toBe('acct-test')
      expect((takeoverStep!.payload as Record<string, unknown>).reason).toBe(
        'agent stuck on the modal',
      )
    })

    it('returns 409 on a second takeover request while already paused_by_user', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      await registerRunningRun('run-double', 'ws-1', 'running')

      const first = await app.request(
        '/v1/runtime/runs/run-double/takeover',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Workspace-Token': token,
          },
          body: JSON.stringify({}),
        },
      )
      expect(first.status).toBe(200)

      const second = await app.request(
        '/v1/runtime/runs/run-double/takeover',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Workspace-Token': token,
          },
          body: JSON.stringify({}),
        },
      )
      expect(second.status).toBe(409)
      const body = (await res2Json(second)) as {
        error: string
        status: string
      }
      expect(body.error).toBe('takeover_not_allowed')
      expect(body.status).toBe('paused_by_user')
    })
  })

  describe('POST /v1/runtime/runs/:runId/resume', () => {
    it('requires a workspace token', async () => {
      const app = await freshApp()
      const res = await app.request('/v1/runtime/runs/run-x/resume', {
        method: 'POST',
      })
      expect(res.status).toBe(401)
    })

    it('returns 404 for unknown run', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      const res = await app.request('/v1/runtime/runs/missing/resume', {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      })
      expect(res.status).toBe(404)
    })

    it('returns 403 cross-workspace', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-attacker')
      await registerRunningRun('run-victim', 'ws-victim', 'paused_by_user')

      const res = await app.request('/v1/runtime/runs/run-victim/resume', {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      })
      expect(res.status).toBe(403)
    })

    it('returns 409 when run is not currently in takeover (status=running)', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      await registerRunningRun('run-running', 'ws-1', 'running')

      const res = await app.request('/v1/runtime/runs/run-running/resume', {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('resume_not_allowed')
    })

    it('200 happy path: flips status to running, signals waiter, emits SSE', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      await registerRunningRun('run-resume', 'ws-1', 'running')

      // Step 1: takeover.
      const t = await app.request('/v1/runtime/runs/run-resume/takeover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({}),
      })
      expect(t.status).toBe(200)

      // Step 2: resume.
      const res = await app.request('/v1/runtime/runs/run-resume/resume', {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        status: string
        resumed_at: string
      }
      expect(body.status).toBe('running')
      expect(typeof body.resumed_at).toBe('string')

      // Run state flipped back.
      const { get } = await import('../orchestrator/runState.js')
      const r = await get('run-resume')
      expect(r.status).toBe('running')

      // Takeover flag cleared.
      const { isTakeoverActive } = await import(
        '../orchestrator/takeoverSignal.js'
      )
      expect(isTakeoverActive('run-resume')).toBe(false)

      // Subscribe after both events fired — the eventbus replays the
      // buffered events to new subscribers, so we can drain them
      // without race conditions.
      const eventbus = await import('../orchestrator/eventbus.js')
      const seen: string[] = []
      const iter = eventbus.subscribe('run-resume')[Symbol.asyncIterator]()
      for (let i = 0; i < 20; i++) {
        const r = await Promise.race([
          iter.next(),
          new Promise<{ value: undefined; done: true }>((res) =>
            setTimeout(() => res({ value: undefined, done: true }), 10),
          ),
        ])
        if (r.done) break
        seen.push(r.value.type)
      }
      expect(seen).toContain('takeover_started')
      expect(seen).toContain('takeover_ended')
    })

    it('returns 409 if resume is called twice (second sees status=running)', async () => {
      const app = await freshApp()
      const token = await signTestToken('ws-1')
      await registerRunningRun('run-double-resume', 'ws-1', 'running')

      // Takeover then resume once.
      await app.request('/v1/runtime/runs/run-double-resume/takeover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({}),
      })
      const r1 = await app.request(
        '/v1/runtime/runs/run-double-resume/resume',
        {
          method: 'POST',
          headers: { 'X-Workspace-Token': token },
        },
      )
      expect(r1.status).toBe(200)

      const r2 = await app.request(
        '/v1/runtime/runs/run-double-resume/resume',
        {
          method: 'POST',
          headers: { 'X-Workspace-Token': token },
        },
      )
      expect(r2.status).toBe(409)
    })
  })
})

async function res2Json(res: Response): Promise<unknown> {
  return await res.json()
}

// =============================================================================
// Phase 10 — workflow library + DB-driven workflow_id resolution.
//
// The route's `workflow_id` validator is now permissive (any non-empty
// string). Built-in IDs continue to dispatch to the in-process handlers
// (and 503 here because BROWSERBASE_API_KEY is unset). Unknown / non-built-in
// IDs are looked up against the workspace's runtime_workflows store and 404
// when missing. Disabled DB workflows surface as 409.
// =============================================================================

describe('POST /v1/runtime/runs — Phase 10 widened workflow_id', () => {
  it('built-in hello-world still dispatches (proven by 503 from missing Browserbase keys)', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: 'hello-world' }),
    })
    expect(res.status).toBe(503)
  })

  it('built-in agent-helloworld still dispatches', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: 'agent-helloworld' }),
    })
    expect(res.status).toBe(503)
  })

  it('returns 400 unknown_workflow when workflow_id is neither built-in nor a workspace row', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: 'no-such-workflow' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('unknown_workflow')
  })

  it('resolves a UUID against the workspace workflow row and dispatches (503 proves resolution succeeded)', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const wf = await import('../orchestrator/workflowsRepo.js')
    const created = await wf.create({
      workspaceId: 'ws-1',
      name: 'My WF',
      prompt: 'do the thing',
    })

    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: created.id }),
    })
    expect(res.status).toBe(503)
  })

  it('returns 400 unknown_workflow when the UUID belongs to a different workspace', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-attacker')
    const wf = await import('../orchestrator/workflowsRepo.js')
    const created = await wf.create({
      workspaceId: 'ws-victim',
      name: 'Victim',
      prompt: 'p',
    })
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: created.id }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('unknown_workflow')
  })

  it('returns 409 workflow_disabled when the row is disabled', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-1')
    const wf = await import('../orchestrator/workflowsRepo.js')
    const created = await wf.create({
      workspaceId: 'ws-1',
      name: 'Off',
      prompt: 'p',
      enabled: false,
    })
    const res = await app.request('/v1/runtime/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ workflow_id: created.id }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('workflow_disabled')
  })
})

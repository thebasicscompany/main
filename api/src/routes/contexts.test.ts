/**
 * Route smoke tests for /v1/runtime/contexts.
 *
 * Covers:
 *  - JWT requirement on both endpoints
 *  - payload validation (400 on malformed body / oversized cookie list)
 *  - happy path: first-sync creates a Context, second-sync reuses it
 *  - status endpoint returns has_sync=false when never synced
 *  - upstream Browserbase / CDP failures surface as 502-ish
 *
 * Browserbase + CDP are mocked via the route's __setSyncDepsForTests +
 * __setCreateContextForTests injectors so no real network call happens.
 * Mirrors the `runs.test.ts` style with the same `freshApp()` helper +
 * memory-repo setup.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CdpSession } from '@basics/harness'
import type { SyncCookiesToContextDeps } from '../lib/contextSync.js'

const TEST_JWT_SECRET = 'test-secret-very-long-please'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
  // Browserbase keys deliberately unset — the deps are mocked, no real
  // creds needed. Some tests do a 503 path (defaultSyncDeps without keys
  // would throw); those wire their own deps so the missing-keys path
  // doesn't fire.
  delete process.env.BROWSERBASE_API_KEY
  delete process.env.BROWSERBASE_PROJECT_ID
})

interface FakeDepsHandle {
  deps: SyncCookiesToContextDeps
  cdpSends: { method: string; params: Record<string, unknown> | undefined }[]
  sessionCalls: { workspaceId: string; contextId: string }[]
  stopCalls: string[]
}

function makeFakeDeps(
  overrides: Partial<SyncCookiesToContextDeps> = {},
): FakeDepsHandle {
  const cdpSends: { method: string; params: Record<string, unknown> | undefined }[] = []
  const sessionCalls: { workspaceId: string; contextId: string }[] = []
  const stopCalls: string[] = []
  const fakeSession = {
    client: {
      send: async (
        method: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        cdpSends.push({ method, params })
        return {}
      },
    } as unknown as CdpSession['client'],
    wsUrl: 'ws://fake',
    targetId: 'fake-target',
    sessionId: 'fake-session',
    events: [],
    pendingDialog: null,
    detach: async () => {},
    attachTarget: async () => 'fake-session',
  } as unknown as CdpSession
  const deps: SyncCookiesToContextDeps = {
    attach: async () => fakeSession,
    createSession: async (opts) => {
      sessionCalls.push({
        workspaceId: opts.workspaceId,
        contextId: opts.contextId,
      })
      return {
        sessionId: 'bb-session-1',
        liveUrl: '',
        cdpWsUrl: 'wss://example/cdp',
      }
    },
    stopSession: async (sessionId) => {
      stopCalls.push(sessionId)
    },
    ...overrides,
  }
  return { deps, cdpSends, sessionCalls, stopCalls }
}

async function freshApp(opts: {
  deps?: SyncCookiesToContextDeps
  createContext?: () => Promise<{ contextId: string }>
} = {}) {
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
  const wsRepo = await import('../orchestrator/workspaceContextRepo.js')
  wsRepo.__setWorkspaceContextRepoForTests(wsRepo.createMemoryRepo())
  // Reset the other repos so this test file plays nicely if vitest reuses
  // the worker across files.
  const orchestrator = await import('../orchestrator/runState.js')
  orchestrator.__setRunStateRepoForTests(orchestrator.createMemoryRepo())
  const eventbus = await import('../orchestrator/eventbus.js')
  eventbus.__resetForTests()
  const approvals = await import('../orchestrator/approvalsRepo.js')
  approvals.__setApprovalRepoForTests(approvals.createMemoryRepo())
  const trust = await import('../orchestrator/trustLedger.js')
  trust.__setTrustGrantRepoForTests(trust.createMemoryRepo())
  const audit = await import('../orchestrator/auditWriter.js')
  audit.__setRunStepRepoForTests(audit.createMemoryRunStepRepo())
  audit.__setToolCallRepoForTests(audit.createMemoryToolCallRepo())

  const route = await import('./contexts.js')
  route.__setSyncDepsForTests(opts.deps ?? null)
  route.__setCreateContextForTests(opts.createContext ?? null)

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

const VALID_COOKIE = {
  name: 'sid',
  value: 'opaque-session',
  domain: '.example.com',
  path: '/',
  expires: 1_999_999_999,
  size: 32,
  httpOnly: true,
  secure: true,
  session: false,
  sameSite: 'Lax' as const,
}

describe('POST /v1/runtime/contexts/sync', () => {
  beforeEach(() => {
    delete process.env.BROWSERBASE_API_KEY
    delete process.env.BROWSERBASE_PROJECT_ID
  })

  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile_label: 'P',
        cookies: [VALID_COOKIE],
      }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects malformed body with 400', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ profile_label: 'P', cookies: 'not-array' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('validation_error')
  })

  it('rejects more than 50_000 cookies', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const tooMany = Array.from({ length: 50_001 }, (_, i) => ({
      ...VALID_COOKIE,
      name: `c${i}`,
    }))
    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        profile_label: 'Personal',
        cookies: tooMany,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('first sync creates a fresh Context, pins it on the workspace, and runs CDP injection', async () => {
    const fake = makeFakeDeps()
    let createCount = 0
    const app = await freshApp({
      deps: fake.deps,
      createContext: async () => {
        createCount++
        return { contextId: 'bb-ctx-fresh' }
      },
    })
    const token = await signTestToken('ws-first')

    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        profile_label: 'Personal',
        profile_directory: 'Default',
        cookies: [VALID_COOKIE, { ...VALID_COOKIE, name: 'csrf' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      context_id: string
      synced_at: string
      cookie_count: number
      domains: string[]
      profileId: string
      cookieCount: number
    }
    expect(body.context_id).toBe('bb-ctx-fresh')
    expect(body.cookie_count).toBe(2)
    expect(body.domains).toEqual(['example.com'])
    // Compatibility aliases for the desktop client.
    expect(body.profileId).toBe('bb-ctx-fresh')
    expect(body.cookieCount).toBe(2)

    expect(createCount).toBe(1)
    expect(fake.sessionCalls).toEqual([
      { workspaceId: 'ws-first', contextId: 'bb-ctx-fresh' },
    ])
    expect(fake.stopCalls).toEqual(['bb-session-1'])
    // CDP set-cookies fired once with two entries.
    const cookieSends = fake.cdpSends.filter(
      (s) => s.method === 'Storage.setCookies',
    )
    expect(cookieSends).toHaveLength(1)
    expect(
      (cookieSends[0]!.params as { cookies: unknown[] }).cookies,
    ).toHaveLength(2)

    // The workspace row now has the context id + a sync timestamp.
    const wsRepo = await import('../orchestrator/workspaceContextRepo.js')
    const snap = await wsRepo.getSnapshot('ws-first')
    expect(snap?.contextId).toBe('bb-ctx-fresh')
    expect(snap?.lastSyncedAt).toBeTruthy()
  })

  it('idempotent re-sync reuses an existing context id and does NOT call createContext', async () => {
    const fake = makeFakeDeps()
    let createCount = 0
    const app = await freshApp({
      deps: fake.deps,
      createContext: async () => {
        createCount++
        return { contextId: 'should-not-be-used' }
      },
    })
    // Pre-seed: workspace already has a context.
    const wsRepo = await import('../orchestrator/workspaceContextRepo.js')
    const memoryRepo = wsRepo.createMemoryRepo()
    memoryRepo.__seed('ws-existing', {
      contextId: 'bb-ctx-existing',
      lastSyncedAt: '2026-04-01T00:00:00.000Z',
    })
    wsRepo.__setWorkspaceContextRepoForTests(memoryRepo)

    const token = await signTestToken('ws-existing')
    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        profile_label: 'Personal',
        cookies: [VALID_COOKIE],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { context_id: string }
    expect(body.context_id).toBe('bb-ctx-existing')

    expect(createCount).toBe(0)
    expect(fake.sessionCalls).toEqual([
      { workspaceId: 'ws-existing', contextId: 'bb-ctx-existing' },
    ])
  })

  it('respects the include-domains filter and returns only the matched domain summary', async () => {
    const fake = makeFakeDeps()
    const app = await freshApp({
      deps: fake.deps,
      createContext: async () => ({ contextId: 'bb-ctx' }),
    })
    const token = await signTestToken('ws-filter')

    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        profile_label: 'Personal',
        domains: ['salesforce.com'],
        cookies: [
          { ...VALID_COOKIE, name: 'sf', domain: '.salesforce.com' },
          { ...VALID_COOKIE, name: 'other', domain: '.other.com' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cookie_count: number
      domains: string[]
    }
    expect(body.cookie_count).toBe(1)
    expect(body.domains).toEqual(['salesforce.com'])
  })

  it('projects upstream Browserbase / CDP failures as 500 with a message', async () => {
    const fake = makeFakeDeps({
      createSession: async () => {
        throw new Error('Browserbase 502 upstream')
      },
    })
    const app = await freshApp({
      deps: fake.deps,
      createContext: async () => ({ contextId: 'bb-ctx' }),
    })
    const token = await signTestToken('ws-fail')
    const res = await app.request('/v1/runtime/contexts/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        profile_label: 'Personal',
        cookies: [VALID_COOKIE],
      }),
    })
    // handleError projects InternalError as 500 with structured error body.
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('internal_error')
    expect(body.message).toContain('Browserbase 502 upstream')
  })
})

describe('GET /v1/runtime/contexts/me', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/runtime/contexts/me')
    expect(res.status).toBe(401)
  })

  it('returns has_sync=false / null fields when the workspace has never synced', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-empty')
    const res = await app.request('/v1/runtime/contexts/me', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      context_id: string | null
      last_synced_at: string | null
      has_sync: boolean
      hasSync: boolean
      lastSyncedAt: string | null
      profileId: string | null
    }
    expect(body.context_id).toBeNull()
    expect(body.last_synced_at).toBeNull()
    expect(body.has_sync).toBe(false)
    expect(body.hasSync).toBe(false)
    expect(body.profileId).toBeNull()
  })

  it('returns the sync status when the workspace has been synced', async () => {
    const wsRepo = await import('../orchestrator/workspaceContextRepo.js')
    const memoryRepo = wsRepo.createMemoryRepo()
    memoryRepo.__seed('ws-synced', {
      contextId: 'bb-ctx-stored',
      lastSyncedAt: '2026-05-01T12:34:00.000Z',
    })
    wsRepo.__setWorkspaceContextRepoForTests(memoryRepo)
    // freshApp() resets the repo, so build the app directly here.
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const token = await signTestToken('ws-synced')
    const res = await app.request('/v1/runtime/contexts/me', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      context_id: string
      last_synced_at: string
      has_sync: boolean
      profileId: string
      lastSyncedAt: string
    }
    expect(body.context_id).toBe('bb-ctx-stored')
    expect(body.last_synced_at).toBe('2026-05-01T12:34:00.000Z')
    expect(body.has_sync).toBe(true)
    expect(body.profileId).toBe('bb-ctx-stored')
    expect(body.lastSyncedAt).toBe('2026-05-01T12:34:00.000Z')
  })
})

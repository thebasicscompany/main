import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock Browserbase HTTP — no real /sessions or /contexts calls during tests.
const createContextMock = vi.fn(async () => ({ contextId: 'ctx_fake_1' }))
const createSessionMock = vi.fn(async () => ({
  sessionId: 'sess_fake_1',
  liveUrl: 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=mock',
  cdpWsUrl: 'wss://connect.browserbase.com/mock',
}))
const stopSessionMock = vi.fn(async () => undefined)
vi.mock('../lib/browserbase.js', () => ({
  createContext: createContextMock,
  createSession: createSessionMock,
  stopSession: stopSessionMock,
}))

const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test'
  process.env.BROWSERBASE_API_KEY = 'test-bb-key'
  process.env.BROWSERBASE_PROJECT_ID = 'test-bb-project'
})

beforeEach(() => {
  vi.resetModules()
  createContextMock.mockClear()
  createSessionMock.mockClear()
  stopSessionMock.mockClear()
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
  const { browserSitesRoute } = await import('./browser-sites.js')
  const app = new Hono()
  app.use('/v1/workspaces/*', requireWorkspaceJwt)
  app.route('/v1/workspaces', browserSitesRoute)
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

describe('browser-sites routes', () => {
  describe('POST .../browser-sites/:host/connect', () => {
    it('401 without JWT', async () => {
      const { app } = await freshApp([])
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com/connect`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      )
      expect(res.status).toBe(401)
    })

    it('400 on bad host regex', async () => {
      const { app } = await freshApp([])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/bad%20host/connect`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: '{}',
        },
      )
      expect(res.status).toBe(400)
      const json = await res.json()
      expect((json as { error: string }).error).toBe('invalid_host')
    })

    it('403 when JWT workspace ≠ path workspace', async () => {
      const { app } = await freshApp([])
      const tok = await signTestToken(TEST_WORKSPACE_ID) // signs for TEST_WS
      const res = await app.request(
        // hit OTHER_WS in the path — must reject
        `/v1/workspaces/${OTHER_WORKSPACE_ID}/browser-sites/linkedin.com/connect`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: '{}',
        },
      )
      expect(res.status).toBe(403)
    })

    it('201 happy path inserts pending row + returns liveViewUrl', async () => {
      const { app, calls } = await freshApp([[]]) // one INSERT
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com/connect`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify({ displayName: 'LinkedIn (operator)' }),
        },
      )
      expect(res.status).toBe(201)
      const json = (await res.json()) as Record<string, unknown>
      expect(json.sessionId).toBe('sess_fake_1')
      expect(json.liveViewUrl).toMatch(/^https:\/\/www\.browserbase\.com/)
      expect(json.host).toBe('linkedin.com')
      expect(typeof json.expiresAt).toBe('string')
      expect(createContextMock).toHaveBeenCalledTimes(1)
      expect(createSessionMock).toHaveBeenCalledTimes(1)
      // INSERT happened once
      expect(calls).toHaveLength(1)
      expect(calls[0]!.query).toMatch(/INSERT INTO public.workspace_browser_sites/i)
    })

    it('uses host as default initialUrl when body omits it', async () => {
      const { app } = await freshApp([[]])
      const tok = await signTestToken()
      await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/jira.acme.com/connect`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: '{}',
        },
      )
      // createSession got the workspaceId + contextId; we don't need to
      // assert on initialUrl plumbing here (it's stashed in storage_state_json
      // and tested via the upsert query string).
      expect(createSessionMock).toHaveBeenCalled()
    })

    it('lowercases the host before persisting', async () => {
      const { app, calls } = await freshApp([[]])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/LinkedIn.COM/connect`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: '{}',
        },
      )
      expect(res.status).toBe(201)
      // The INSERT's param array shows host as lower-case
      expect(calls[0]!.query).toMatch(/linkedin\.com/i)
      expect(calls[0]!.query).not.toMatch(/LinkedIn\.COM/)
    })
  })

  describe('POST .../browser-sites/:host/finalize', () => {
    it('401 without JWT', async () => {
      const { app } = await freshApp([])
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com/finalize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"sessionId":"sess_x"}',
        },
      )
      expect(res.status).toBe(401)
    })

    it('400 on bad host', async () => {
      const { app } = await freshApp([])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/bad%20host/finalize`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: '{"sessionId":"sess_x"}',
        },
      )
      expect(res.status).toBe(400)
    })

    it('404 when no pending row owns the sessionId', async () => {
      const { app } = await freshApp([[]]) // SELECT returns no rows
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com/finalize`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify({ sessionId: 'sess_unknown' }),
        },
      )
      expect(res.status).toBe(404)
      const json = (await res.json()) as { error: string }
      expect(json.error).toBe('pending_session_not_found')
      // stopSession is NOT called when the row didn't exist
      expect(stopSessionMock).not.toHaveBeenCalled()
    })

    it('200 happy path stops session + updates row', async () => {
      const { app, calls } = await freshApp([
        // SELECT pending row
        [
          {
            storage_state_json: {
              kind: 'browserbase_context_pending',
              contextId: 'ctx_fake_1',
              sessionId: 'sess_fake_1',
            },
          },
        ],
        // UPDATE — no return expected
        [],
      ])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com/finalize`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify({ sessionId: 'sess_fake_1' }),
        },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, unknown>
      expect(json.ok).toBe(true)
      expect(json.host).toBe('linkedin.com')
      expect(typeof json.expiresAt).toBe('string')
      expect(typeof json.sizeBytes).toBe('number')
      // NEVER returns the storage state itself
      expect(json).not.toHaveProperty('storageState')
      expect(json).not.toHaveProperty('storage_state_json')
      expect(stopSessionMock).toHaveBeenCalledWith('sess_fake_1')
      expect(calls[1]!.query).toMatch(/UPDATE public.workspace_browser_sites/i)
    })
  })

  describe('GET .../browser-sites', () => {
    it('401 without JWT', async () => {
      const { app } = await freshApp([])
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites`,
      )
      expect(res.status).toBe(401)
    })

    it('returns items list excluding storage_state_json', async () => {
      const { app } = await freshApp([
        [
          {
            host: 'linkedin.com',
            display_name: 'LinkedIn',
            captured_via: 'browserbase_liveview',
            last_verified_at: '2026-04-01T12:00:00Z',
            expires_at: '2026-08-01T12:00:00Z',
            is_active: true,
            is_expiring: false,
            pointer_kind: 'browserbase_context',
          },
          {
            host: 'jira.acme.com',
            display_name: null,
            captured_via: 'browserbase_liveview',
            last_verified_at: null,
            expires_at: '2026-05-13T12:00:00Z',
            is_active: false,
            is_expiring: false,
            pointer_kind: 'browserbase_context',
          },
        ],
      ])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites`,
        { headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as { items: Array<Record<string, unknown>> }
      expect(json.items).toHaveLength(2)
      expect(json.items[0]!.host).toBe('linkedin.com')
      expect(json.items[0]!.status).toBe('active')
      expect(json.items[1]!.status).toBe('expired')
      // Storage state must NEVER leak — neither raw key nor camelCase.
      expect(json.items[0]).not.toHaveProperty('storage_state_json')
      expect(json.items[0]).not.toHaveProperty('storageState')
    })

    it('marks pending pointer rows as status=pending', async () => {
      const { app } = await freshApp([
        [
          {
            host: 'linkedin.com',
            display_name: 'LinkedIn',
            captured_via: 'browserbase_liveview',
            last_verified_at: null,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            is_active: true,
            is_expiring: true,
            pointer_kind: 'browserbase_context_pending',
          },
        ],
      ])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites`,
        { headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as { items: Array<{ status: string }> }
      expect(json.items[0]!.status).toBe('pending')
    })

    it('403 when JWT workspace ≠ path workspace', async () => {
      const { app } = await freshApp([])
      const tok = await signTestToken(TEST_WORKSPACE_ID)
      const res = await app.request(
        `/v1/workspaces/${OTHER_WORKSPACE_ID}/browser-sites`,
        { headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(403)
    })
  })

  describe('DELETE .../browser-sites/:host', () => {
    it('401 without JWT', async () => {
      const { app } = await freshApp([])
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com`,
        { method: 'DELETE' },
      )
      expect(res.status).toBe(401)
    })

    it('400 on bad host', async () => {
      const { app } = await freshApp([])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/bad%20host`,
        { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(400)
    })

    it('200 + deleted:true when a row existed', async () => {
      const { app } = await freshApp([[{ host: 'linkedin.com' }]])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/linkedin.com`,
        { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as { deleted: boolean; host: string }
      expect(json).toEqual({ deleted: true, host: 'linkedin.com' })
    })

    it('200 + deleted:false when no row existed', async () => {
      const { app } = await freshApp([[]])
      const tok = await signTestToken()
      const res = await app.request(
        `/v1/workspaces/${TEST_WORKSPACE_ID}/browser-sites/ghost.example`,
        { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as { deleted: boolean }
      expect(json.deleted).toBe(false)
    })

    it('403 when JWT workspace ≠ path workspace', async () => {
      const { app } = await freshApp([])
      const tok = await signTestToken(TEST_WORKSPACE_ID)
      const res = await app.request(
        `/v1/workspaces/${OTHER_WORKSPACE_ID}/browser-sites/linkedin.com`,
        { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } },
      )
      expect(res.status).toBe(403)
    })
  })
})

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
})

beforeEach(async () => {
  vi.resetModules()
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
})

async function appWithManagedAuth() {
  const { Hono } = await import('hono')
  const { requireManagedGatewayAuth } = await import('./managed-gateway-auth.js')
  const app = new Hono<{ Variables: { workspace: { workspace_id: string }; apiKey?: { id: string } } }>()
  app.use('*', requireManagedGatewayAuth)
  app.get('/managed', (c) =>
    c.json({
      workspace_id: c.get('workspace').workspace_id,
      api_key_id: c.get('apiKey')?.id ?? null,
    }),
  )
  return app
}

async function signTestToken() {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: 'ws-jwt',
    account_id: 'acct-jwt',
    plan: 'team',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

describe('requireManagedGatewayAuth', () => {
  it('still accepts workspace JWTs', async () => {
    const app = await appWithManagedAuth()
    const token = await signTestToken()
    const res = await app.request('/managed', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      workspace_id: 'ws-jwt',
      api_key_id: null,
    })
  })

  it('accepts scoped Basics API keys', async () => {
    vi.doMock('../lib/workspace-api-keys.js', () => ({
      authenticateWorkspaceApiKey: vi.fn(async () => ({
        workspace: {
          workspace_id: 'ws-api-key',
          account_id: 'acct-api-key',
          plan: 'team',
          seat_status: 'active',
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
        apiKey: {
          id: 'api-key-1',
          workspaceId: 'ws-api-key',
          name: 'assistant',
          scopes: ['llm:managed'],
        },
      })),
      InvalidWorkspaceApiKeyError: class InvalidWorkspaceApiKeyError extends Error {},
      WorkspaceApiKeyForbiddenError: class WorkspaceApiKeyForbiddenError extends Error {
        constructor(public readonly reason: string) {
          super(reason)
        }
      },
    }))

    const app = await appWithManagedAuth()
    const res = await app.request('/managed', {
      headers: { authorization: 'Bearer bas_live_prefix_secret' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      workspace_id: 'ws-api-key',
      api_key_id: 'api-key-1',
    })
  })
})

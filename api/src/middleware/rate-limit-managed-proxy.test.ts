import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

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
  process.env.MANAGED_GATEWAY_RPM_PER_WORKSPACE = '2'
  process.env.MANAGED_GATEWAY_RPM_PER_API_KEY = '1'
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
  const { __resetManagedProxyRateLimitsForTests } = await import('./rate-limit-managed-proxy.js')
  __resetManagedProxyRateLimitsForTests()
})

async function rateLimitedApp(apiKeyId?: string) {
  const { Hono } = await import('hono')
  type WorkspaceForTest = {
    workspace_id: string
    account_id: string
    plan: 'team'
    seat_status: string
    issued_at: string
    expires_at: string
  }
  type ApiKeyForTest = {
    id: string
    workspaceId: string
    name: string
    scopes: string[]
  }
  const { rateLimitManagedProxy } = await import('./rate-limit-managed-proxy.js')
  const app = new Hono<{ Variables: { workspace: WorkspaceForTest; apiKey?: ApiKeyForTest } }>()
  app.use('*', async (c, next) => {
    c.set('workspace', {
      workspace_id: 'ws-rate-limit',
      account_id: 'acct-rate-limit',
      plan: 'team',
      seat_status: 'active',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    if (apiKeyId) {
      c.set('apiKey', {
        id: apiKeyId,
        workspaceId: 'ws-rate-limit',
        name: 'assistant',
        scopes: ['llm:managed'],
      })
    }
    await next()
  })
  app.use('*', rateLimitManagedProxy())
  app.get('/managed', (c) => c.json({ ok: true }))
  return app
}

describe('rateLimitManagedProxy', () => {
  it('returns 429 and rate-limit headers after the workspace threshold', async () => {
    const app = await rateLimitedApp()
    expect((await app.request('/managed')).status).toBe(200)
    expect((await app.request('/managed')).status).toBe(200)
    const limited = await app.request('/managed')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    expect(limited.headers.get('x-ratelimit-limit')).toBe('2')
    expect(await limited.json()).toEqual({
      error: 'rate_limited',
      reason: 'managed_proxy_quota',
    })
  })

  it('applies the stricter per-api-key threshold', async () => {
    const app = await rateLimitedApp('api-key-rate-limit')
    expect((await app.request('/managed')).status).toBe(200)
    const limited = await app.request('/managed')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('x-ratelimit-limit')).toBe('1')
  })
})

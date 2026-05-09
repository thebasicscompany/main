import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
  process.env.SUPABASE_ANON_KEY = 'test-anon'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
})

beforeEach(async () => {
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function freshApp() {
  const { buildApp } = await import('../app.js')
  return buildApp()
}

describe('POST /v1/auth/refresh', () => {
  it('rejects empty body with 400', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  it('rejects body with empty refresh token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supabase_refresh_token: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects unknown body keys (strict schema)', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supabase_refresh_token: 'r', extra: 'no' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 503 when SUPABASE_ANON_KEY is unset', async () => {
    const saved = process.env.SUPABASE_ANON_KEY
    delete process.env.SUPABASE_ANON_KEY
    try {
      const { __resetConfigForTests } = await import('../config.js')
      __resetConfigForTests()
      const app = await freshApp()
      const res = await app.request('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ supabase_refresh_token: 'rt' }),
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('not_configured')
    } finally {
      if (saved !== undefined) process.env.SUPABASE_ANON_KEY = saved
    }
  })

  it('returns 401 when Supabase rejects the refresh token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const app = await freshApp()
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supabase_refresh_token: 'rt' }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_refresh_token')
  })

  it('returns 401 when Supabase responds 200 without an access token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const app = await freshApp()
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supabase_refresh_token: 'rt' }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_refresh_token')
  })

  it('hits the Supabase refresh endpoint with the anon key + refresh token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = await freshApp()
    await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supabase_refresh_token: 'the-token' }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ]
    expect(url).toBe(
      'https://example.supabase.co/auth/v1/token?grant_type=refresh_token',
    )
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.apikey).toBe('test-anon')
    expect(JSON.parse(init?.body as string)).toEqual({ refresh_token: 'the-token' })
  })
})

/**
 * Tests for the Managed LLM Gateway credential bridge.
 *
 * The bridge sits between `requireWorkspaceJwt` and the mounted gateway
 * Hono app. It must:
 *   1. Reject requests for unknown provider slugs with 400.
 *   2. Resolve a workspace credential, surfacing 503 when none is available
 *      and the pooled fallback is also unset.
 *   3. Inject the headers the upstream gateway code expects
 *      (`x-basics-gw-provider`, plus per-provider auth) and strip the
 *      daemon's workspace JWT before forwarding.
 *   4. Strip the `/v1/llm/managed/<slug>` prefix from the URL so the
 *      mounted gateway sees `/v1/...` paths.
 *
 * We don't reach upstream provider APIs in these tests; we mock the
 * resolver and the gateway app to capture what the bridge passes through.
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
  process.env.GEMINI_API_KEY = 'test-gemini-pooled'
  process.env.OPENAI_API_KEY = 'test-openai-pooled'
})

async function signTestToken(workspaceId = WS) {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: ACCT,
    plan: 'team',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

beforeEach(() => {
  vi.resetModules()
})

describe('gatewayCredentialBridge', () => {
  it('returns 400 for unknown provider slug', async () => {
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const token = await signTestToken()
    const res = await app.request('/v1/llm/managed/notaprovider/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'whatever' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; reason?: string }
    expect(body.error).toBe('invalid_request')
    expect(body.reason).toBe('unknown_provider')
  })

  it('returns 401 without a workspace token', async () => {
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const res = await app.request('/v1/llm/managed/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 503 no_credential when no key + no pooled fallback', async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_PLATFORM_KEY

    vi.doMock('../orchestrator/credential-resolver.js', async () => {
      const actual = await vi.importActual<
        typeof import('../orchestrator/credential-resolver.js')
      >('../orchestrator/credential-resolver.js')
      return {
        ...actual,
        resolveGatewayCredential: vi.fn(async () => {
          throw new actual.NoCredentialError({ workspaceId: WS, kind: 'anthropic' })
        }),
      }
    })

    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const token = await signTestToken()
    const res = await app.request('/v1/llm/managed/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; kind?: string }
    expect(body.error).toBe('no_credential')
    expect(body.kind).toBe('anthropic')
  })

  it('returns 503 not_configured when DB is unavailable', async () => {
    vi.doMock('../orchestrator/credential-resolver.js', async () => {
      const actual = await vi.importActual<
        typeof import('../orchestrator/credential-resolver.js')
      >('../orchestrator/credential-resolver.js')
      const { DatabaseUnavailableError } = await import('../lib/errors.js')
      return {
        ...actual,
        resolveGatewayCredential: vi.fn(async () => {
          throw new DatabaseUnavailableError()
        }),
      }
    })

    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const token = await signTestToken()
    const res = await app.request('/v1/llm/managed/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-5' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_configured')
  })

  it('injects gateway provider + auth headers and strips workspace JWT', async () => {
    // Replace the mounted gateway app with a Hono stub that echoes the request
    // it receives. This isolates the bridge from upstream gateway internals
    // (request validation, provider transforms, fetch out to providers).
    let captured: { url: string; headers: Record<string, string>; method: string } | null = null
    vi.doMock('../gateway/index.js', async () => {
      const { Hono } = await import('hono')
      const app = new Hono()
      app.all('*', async (c) => {
        captured = {
          url: c.req.url,
          method: c.req.raw.method,
          headers: Object.fromEntries(c.req.raw.headers.entries()),
        }
        return c.json({ ok: true }, 200)
      })
      return { default: app }
    })

    vi.doMock('../orchestrator/credential-resolver.js', async () => {
      const actual = await vi.importActual<
        typeof import('../orchestrator/credential-resolver.js')
      >('../orchestrator/credential-resolver.js')
      return {
        ...actual,
        resolveGatewayCredential: vi.fn(async () => ({
          plaintext: 'sk-ant-test-bridge',
          credentialId: 'cred-1',
          usageTag: 'customer_byok' as const,
        })),
      }
    })

    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const token = await signTestToken()
    const res = await app.request('/v1/llm/managed/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).not.toBeNull()
    if (!captured) throw new Error('handler did not run')
    // Explicit cast — TypeScript narrows the let through the doMock closure to
    // `null` and treats the post-throw flow as `never`.
    const cap = captured as { url?: string; method?: string; headers: Record<string, string> }

    // URL prefix stripped: gateway sees `/v1/messages`, not `/v1/llm/managed/anthropic/v1/messages`.
    const path = new URL(cap.url ?? '').pathname
    expect(path).toBe('/v1/messages')

    // Provider routing header set.
    expect(cap.headers['x-basics-gw-provider']).toBe('anthropic')
    // Anthropic-specific x-api-key set to plaintext.
    expect(cap.headers['x-api-key']).toBe('sk-ant-test-bridge')
    // Authorization rewritten away from workspace JWT to the provider key.
    expect(cap.headers['authorization']).toBe('Bearer sk-ant-test-bridge')
    expect(cap.headers['authorization']).not.toContain(token)
    // Tag headers for downstream metering.
    expect(cap.headers['x-basics-credential-id']).toBe('cred-1')
    expect(cap.headers['x-basics-usage-tag']).toBe('customer_byok')
  })

  it('routes /openai/* with Bearer auth and no x-api-key', async () => {
    let captured: { headers: Record<string, string> } | null = null
    vi.doMock('../gateway/index.js', async () => {
      const { Hono } = await import('hono')
      const app = new Hono()
      app.all('*', async (c) => {
        captured = { headers: Object.fromEntries(c.req.raw.headers.entries()) }
        return c.json({ ok: true }, 200)
      })
      return { default: app }
    })
    vi.doMock('../orchestrator/credential-resolver.js', async () => {
      const actual = await vi.importActual<
        typeof import('../orchestrator/credential-resolver.js')
      >('../orchestrator/credential-resolver.js')
      return {
        ...actual,
        resolveGatewayCredential: vi.fn(async () => ({
          plaintext: 'sk-openai-test',
          credentialId: 'cred-openai',
          usageTag: 'basics_managed_per_workspace' as const,
        })),
      }
    })

    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const token = await signTestToken()
    const res = await app.request('/v1/llm/managed/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-5', messages: [] }),
    })

    expect(res.status).toBe(200)
    expect(captured).not.toBeNull()
    if (!captured) throw new Error('handler did not run')
    // Explicit cast — TypeScript narrows the let through the doMock closure to
    // `null` and treats the post-throw flow as `never`.
    const cap = captured as { url?: string; method?: string; headers: Record<string, string> }
    expect(cap.headers['x-basics-gw-provider']).toBe('openai')
    expect(cap.headers['authorization']).toBe('Bearer sk-openai-test')
    // Anthropic-specific header should NOT be set on OpenAI requests.
    expect(cap.headers['x-api-key']).toBeUndefined()
  })

  it('health endpoint still advertises llm_managed_proxy capability', async () => {
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { capabilities: { llm_managed_proxy: boolean } }
    expect(body.capabilities.llm_managed_proxy).toBe(true)
  })
})

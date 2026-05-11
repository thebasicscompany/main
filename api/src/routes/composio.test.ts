import { createHmac } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const WEBHOOK_SECRET = 'test-composio-webhook-secret'
const NOW = 1_777_777_777

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
})

beforeEach(async () => {
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
  process.env.COMPOSIO_API_KEY = 'test-composio-key'
  process.env.BASICS_COMPOSIO_API_KEY = ''
  process.env.COMPOSIO_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.BASICS_COMPOSIO_WEBHOOK_SECRET = ''
  process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
  vi.doMock('../db/index.js', () => ({
    db: { execute: vi.fn(async () => []) },
  }))
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
})

async function freshApp() {
  const { buildApp } = await import('../app.js')
  return buildApp()
}

async function signTestToken(workspaceId = 'ws-composio-test', accountId = 'acct-composio-test') {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function signedHeaders(body: string, overrides?: { secret?: string; signature?: string }) {
  const id = 'evt-123'
  const timestamp = String(NOW)
  const signature =
    overrides?.signature ??
    `v1,${createHmac('sha256', overrides?.secret ?? WEBHOOK_SECRET)
      .update(`${id}.${timestamp}.${body}`, 'utf8')
      .digest('base64')}`
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  }
}

describe('Composio runtime routes', () => {
  it('requires workspace auth for Composio skill APIs', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/skills/composio/tools')
    expect(res.status).toBe(401)
  })

  it('returns capability_unavailable when Composio API key is missing', async () => {
    process.env.COMPOSIO_API_KEY = ''
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const app = await freshApp()
    const token = await signTestToken()

    const res = await app.request('/v1/skills/composio/tools', {
      headers: { 'X-Workspace-Token': token },
    })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'composio',
    })
  })

  it('lists Composio tools through the configured project', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ slug: 'github_create_issue', name: 'Create issue' }] }),
    )
    const app = await freshApp()
    const token = await signTestToken()

    const res = await app.request('/v1/skills/composio/tools?toolkit_slug=github&q=issue', {
      headers: { 'X-Workspace-Token': token },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      tools: [{ slug: 'github_create_issue', name: 'Create issue' }],
    })
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://composio.example.test/api/tools?limit=100&toolkit_slug=github&query=issue',
    )
  })

  it('creates connect links with workspace account id and normalizes snake_case fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        redirect_url: 'https://connect.composio.dev/link',
        connected_account_id: 'conn-123',
        expires_at: '2026-05-11T12:00:00.000Z',
      }),
    )
    const app = await freshApp()
    const token = await signTestToken('ws-123', 'acct-123')

    const res = await app.request('/v1/skills/composio/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
      body: JSON.stringify({
        authConfigId: 'auth-123',
        callbackUrl: 'basics-assistant://composio/callback',
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      redirectUrl: 'https://connect.composio.dev/link',
      connectedAccountId: 'conn-123',
      expiresAt: '2026-05-11T12:00:00.000Z',
    })
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      auth_config_id: 'auth-123',
      user_id: 'acct-123',
      callback_url: 'basics-assistant://composio/callback',
    })
  })

  it('disconnects and executes Composio tools', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'issue-1' } }))
    const app = await freshApp()
    const token = await signTestToken('ws-123', 'acct-123')

    const disconnect = await app.request('/v1/skills/composio/connections/conn-123', {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(disconnect.status).toBe(200)
    expect(await disconnect.json()).toEqual({ ok: true })

    const execute = await app.request('/v1/skills/composio/tools/github_create_issue/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
      body: JSON.stringify({ arguments: { title: 'Hello' }, connectedAccountId: 'conn-123' }),
    })
    expect(execute.status).toBe(200)
    expect(await execute.json()).toEqual({ ok: true, data: { id: 'issue-1' } })
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://composio.example.test/api/connected_accounts/conn-123',
    )
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toMatchObject({
      user_id: 'acct-123',
      connected_account_id: 'conn-123',
      arguments: { title: 'Hello' },
    })
  })

  it('merges Composio managed skills into /v1/skills when include=catalog', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url)
      if (value.includes('/toolkits')) {
        return jsonResponse({ items: [{ slug: 'github', name: 'GitHub', meta: { logo: 'logo' } }] })
      }
      if (value.includes('/auth_configs')) {
        return jsonResponse({
          items: [{ id: 'auth-github', name: 'GitHub', toolkit: { slug: 'github' } }],
        })
      }
      if (value.includes('/connected_accounts/link')) {
        return jsonResponse({ redirect_url: 'https://connect.composio.dev/github' })
      }
      if (value.includes('/connected_accounts')) return jsonResponse({ items: [] })
      return jsonResponse({})
    })
    const app = await freshApp()
    const token = await signTestToken()

    const res = await app.request('/v1/skills?include=catalog', {
      headers: { 'X-Workspace-Token': token },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { skills: Array<{ id: string; source?: string }> }
    expect(body.skills).toContainEqual(
      expect.objectContaining({
        id: 'composio-github',
        source: 'composio',
        authConfigId: 'auth-github',
        connectUrl: 'https://connect.composio.dev/github',
        toolkitSlug: 'github',
      }),
    )
  })
})

describe('Composio webhook route', () => {
  it('rejects missing or invalid webhook signatures', async () => {
    const app = await freshApp()
    const missing = await app.request('/webhooks/composio', {
      method: 'POST',
      body: JSON.stringify({ type: 'composio.trigger.message' }),
    })
    expect(missing.status).toBe(401)

    const rawBody = JSON.stringify({ type: 'composio.trigger.message' })
    const invalid = await app.request('/webhooks/composio', {
      method: 'POST',
      headers: signedHeaders(rawBody, { signature: 'v1,bad' }),
      body: rawBody,
    })
    expect(invalid.status).toBe(401)
  })

  it('accepts supported signed events and ignores unsupported signed events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const app = await freshApp()
    const supportedBody = JSON.stringify({
      id: 'evt-supported',
      type: 'composio.connected_account.expired',
      metadata: { connected_account_id: 'conn-123' },
    })

    const supported = await app.request('/webhooks/composio', {
      method: 'POST',
      headers: signedHeaders(supportedBody),
      body: supportedBody,
    })
    expect(supported.status).toBe(200)
    expect(await supported.json()).toEqual({ ok: true })

    const unsupportedBody = JSON.stringify({ id: 'evt-ignored', type: 'composio.other' })
    const unsupported = await app.request('/webhooks/composio', {
      method: 'POST',
      headers: signedHeaders(unsupportedBody),
      body: unsupportedBody,
    })
    expect(unsupported.status).toBe(200)
    expect(await unsupported.json()).toEqual({ ok: true, ignored: true })
    vi.useRealTimers()
  })
})

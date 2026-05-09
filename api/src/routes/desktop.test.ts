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

async function freshApp() {
  const { buildApp } = await import('../app.js')
  const desktopAssistants = await import('../orchestrator/desktopAssistantsRepo.js')
  desktopAssistants.__setDesktopAssistantsRepoForTests(
    desktopAssistants.createMemoryDesktopAssistantsRepo(),
  )
  return buildApp()
}

async function signTestToken(workspaceId = 'ws-desktop-test') {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: 'acct-desktop-test',
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

describe('POST /v1/desktop/bootstrap', () => {
  it('requires a workspace token', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/desktop/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_installation_id: 'install-123',
        assistant_id: 'assistant-123',
        platform: 'macos',
      }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects malformed bootstrap bodies', async () => {
    const app = await freshApp()
    const token = await signTestToken()
    const res = await app.request('/v1/desktop/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        client_installation_id: 'install-123',
        platform: 'macos',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  it('returns Basics-native credential names', async () => {
    vi.doMock('../lib/workspace-api-keys.js', () => ({
      rotateAssistantApiKey: vi.fn(async () => ({
        key: 'bas_live_testprefix_testsecret',
        meta: { id: 'api-key-123' },
      })),
    }))
    const app = await freshApp()
    const token = await signTestToken('ws-basics')
    const res = await app.request('/v1/desktop/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        client_installation_id: 'install-123',
        assistant_id: 'assistant-123',
        assistant_version: '1.2.3',
        platform: 'macos',
        machine_name: 'Example Mac',
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workspace_id: string
      account_id: string
      assistant_id: string
      assistant_api_key: string
      assistant_api_key_id: string
      credentials: Record<string, string>
      metadata: Record<string, unknown>
    }
    expect(body.workspace_id).toBe('ws-basics')
    expect(body.account_id).toBe('acct-desktop-test')
    expect(body.assistant_id).toContain('asst-')
    expect(body.assistant_api_key).toBe('bas_live_testprefix_testsecret')
    expect(body.assistant_api_key).not.toBe(token)
    expect(body.assistant_api_key_id).toBe('api-key-123')
    expect(body.credentials['basics:assistant_api_key']).toBe(body.assistant_api_key)
    expect(body.credentials['basics:platform_base_url']).toBe(
      'https://api.trybasics.ai',
    )
    expect(body.credentials['basics:platform_assistant_id']).toBe(
      body.assistant_id,
    )
    expect(body.credentials['basics:workspace_id']).toBe('ws-basics')
    expect(body.credentials['basics:account_id']).toBe('acct-desktop-test')
    expect(Object.keys(body.credentials).some((key) => key.startsWith('vellum:'))).toBe(
      false,
    )
    expect(body.metadata.platform).toBe('macos')
  })
})

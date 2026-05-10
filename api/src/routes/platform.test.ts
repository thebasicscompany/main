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
  let keyCounter = 0
  vi.doMock('../lib/workspace-api-keys.js', () => ({
    rotateAssistantApiKey: vi.fn(async () => {
      keyCounter++
      return {
        key: `bas_live_testprefix_testsecret_${keyCounter}`,
        meta: { id: `api-key-${keyCounter}` },
      }
    }),
  }))
  const desktopAssistants = await import('../orchestrator/desktopAssistantsRepo.js')
  desktopAssistants.__setDesktopAssistantsRepoForTests(
    desktopAssistants.createMemoryDesktopAssistantsRepo(),
  )
  const { buildApp } = await import('../app.js')
  return buildApp()
}

async function signTestToken(workspaceId = 'ws-platform-test') {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: 'acct-platform-test',
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

describe('Basics platform compatibility routes', () => {
  it('requires workspace JWT on assistant routes', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/assistants/')
    expect(res.status).toBe(401)
  })

  it('returns the caller workspace as the organization', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-org')
    const res = await app.request('/v1/organizations/', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; results: Array<{ id: string }> }
    expect(body.count).toBe(1)
    expect(body.results[0]?.id).toBe('ws-org')
  })

  it('ensures local registration idempotently and rotates on reprovision', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-local')
    const request = {
      client_installation_id: 'install-123',
      runtime_assistant_id: 'runtime-123',
      client_platform: 'macos',
      assistant_version: '1.2.3',
      machine_name: 'Example Mac',
    }
    const first = await app.request(
      '/v1/assistants/self-hosted-local/ensure-registration/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify(request),
      },
    )
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as {
      assistant: { id: string; runtime_assistant_id: string }
      assistant_api_key: string
    }
    expect(firstBody.assistant.runtime_assistant_id).toBe('runtime-123')
    expect(firstBody.assistant_api_key).toMatch(/^bas_live_/)

    const second = await app.request(
      '/v1/assistants/self-hosted-local/ensure-registration/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify(request),
      },
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      assistant: { id: string }
      assistant_api_key: string | null
    }
    expect(secondBody.assistant.id).toBe(firstBody.assistant.id)
    expect(secondBody.assistant_api_key).toBeNull()

    const rotated = await app.request(
      '/v1/assistants/self-hosted-local/reprovision-api-key/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify(request),
      },
    )
    expect(rotated.status).toBe(200)
    const rotatedBody = (await rotated.json()) as {
      assistant: { id: string }
      provisioning: { assistant_api_key: string }
    }
    expect(rotatedBody.assistant.id).toBe(firstBody.assistant.id)
    expect(rotatedBody.provisioning.assistant_api_key).toMatch(/^bas_live_/)
    expect(rotatedBody.provisioning.assistant_api_key).not.toBe(
      firstBody.assistant_api_key,
    )
  })

  it('keeps the default assistant list scoped to managed assistants', async () => {
    const app = await freshApp()
    const token = await signTestToken('ws-list-scope')

    const localRegistration = await app.request(
      '/v1/assistants/self-hosted-local/ensure-registration/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          client_installation_id: 'install-list-scope',
          runtime_assistant_id: 'runtime-list-scope',
          client_platform: 'macos',
          machine_name: 'Example Mac',
        }),
      },
    )
    expect(localRegistration.status).toBe(201)

    const defaultList = await app.request('/v1/assistants/', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(defaultList.status).toBe(200)
    const defaultBody = (await defaultList.json()) as { count: number }
    expect(defaultBody.count).toBe(0)

    const localList = await app.request('/v1/assistants/?hosting=local', {
      headers: { 'X-Workspace-Token': token },
    })
    expect(localList.status).toBe(200)
    const localBody = (await localList.json()) as {
      count: number
      results: Array<{ hosting: string }>
    }
    expect(localBody.count).toBe(1)
    expect(localBody.results[0]?.hosting).toBe('local')
  })

  it('lists, activates, updates, and retires assistants within the workspace', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('ws-owner')
    const otherToken = await signTestToken('ws-other')
    const hatch = await app.request('/v1/assistants/hatch/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'Desk', description: 'Local control plane' }),
    })
    expect(hatch.status).toBe(201)
    const created = (await hatch.json()) as { id: string; name: string }
    expect(created.name).toBe('Desk')

    const denied = await app.request(`/v1/assistants/${created.id}/`, {
      headers: { 'X-Workspace-Token': otherToken },
    })
    expect(denied.status).toBe(404)

    const patch = await app.request(`/v1/assistants/${created.id}/`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as { name: string }
    expect(patched.name).toBe('Renamed')

    const identity = await app.request(`/v1/assistants/${created.id}/identity/`, {
      headers: { 'X-Workspace-Token': ownerToken },
    })
    expect(identity.status).toBe(200)
    const identityBody = (await identity.json()) as {
      name: string
      role: string
      personality: string
      emoji: string
      home: string
      version: string
      createdAt: string
    }
    expect(identityBody).toEqual({
      name: 'Renamed',
      role: 'Local control plane',
      personality: '',
      emoji: '',
      home: '',
      version: 'cloud',
      createdAt: expect.any(String),
    })

    const identityIntro = await app.request(
      `/v1/assistants/${created.id}/identity/intro/`,
      {
        headers: { 'X-Workspace-Token': ownerToken },
      },
    )
    expect(identityIntro.status).toBe(200)
    expect(await identityIntro.json()).toEqual({ text: "Hi, I'm Renamed." })

    const deniedIdentity = await app.request(
      `/v1/assistants/${created.id}/identity/`,
      {
        headers: { 'X-Workspace-Token': otherToken },
      },
    )
    expect(deniedIdentity.status).toBe(404)

    const active = await app.request(`/v1/assistants/${created.id}/activate/`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': ownerToken },
    })
    expect(active.status).toBe(200)

    const list = await app.request('/v1/assistants/', {
      headers: { 'X-Workspace-Token': ownerToken },
    })
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { count: number }
    expect(listBody.count).toBe(1)

    const retired = await app.request(`/v1/assistants/${created.id}/retire/`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': ownerToken },
    })
    expect(retired.status).toBe(200)

    const missing = await app.request(`/v1/assistants/${created.id}/`, {
      headers: { 'X-Workspace-Token': ownerToken },
    })
    expect(missing.status).toBe(404)
  })
})

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

beforeEach(() => {
  vi.resetModules()
})

async function freshApp() {
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()

  const desktopAssistants = await import('../orchestrator/desktopAssistantsRepo.js')
  desktopAssistants.__setDesktopAssistantsRepoForTests(
    desktopAssistants.createMemoryDesktopAssistantsRepo(),
  )

  const cloudMemory = await import('../orchestrator/cloudMemoryRepo.js')
  const memoryRepo = cloudMemory.createMemoryCloudMemoryRepo()
  cloudMemory.__setCloudMemoryRepoForTests(memoryRepo)

  const { buildApp } = await import('../app.js')
  return { app: buildApp(), memoryRepo }
}

async function signTestToken(workspaceId: string, accountId = 'acct-memory-test') {
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

async function hatchAssistant(app: Awaited<ReturnType<typeof freshApp>>['app'], token: string) {
  const res = await app.request('/v1/assistants/hatch/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Workspace-Token': token,
    },
    body: JSON.stringify({ name: 'Cloud Assistant' }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

describe('managed cloud memory routes', () => {
  it('supports memory item CRUD using desktop-compatible response shapes', async () => {
    const { app } = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000001')
    const assistant = await hatchAssistant(app, token)

    const create = await app.request(`/v1/assistants/${assistant.id}/memory-items/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        kind: 'semantic',
        subject: 'preferred editor',
        statement: 'User prefers the built-in editor.',
        importance: 0.8,
      }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as {
      item: {
        id: string
        kind: string
        subject: string
        statement: string
        status: string
        firstSeenAt: number
        lastSeenAt: number
      }
    }
    expect(created.item).toMatchObject({
      kind: 'semantic',
      subject: 'preferred editor',
      statement: 'User prefers the built-in editor.',
      status: 'active',
    })
    expect(typeof created.item.firstSeenAt).toBe('number')

    const list = await app.request(
      `/v1/assistants/${assistant.id}/memory-items?status=active&search=editor`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as {
      items: Array<{ id: string }>
      total: number
      kindCounts: Record<string, number>
    }
    expect(listed.total).toBe(1)
    expect(listed.items[0]?.id).toBe(created.item.id)
    expect(listed.kindCounts.semantic).toBe(1)

    const update = await app.request(
      `/v1/assistants/${assistant.id}/memory-items/${created.item.id}/`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          statement: 'User prefers the built-in editor for routine drafts.',
          verificationState: 'user_confirmed',
        }),
      },
    )
    expect(update.status).toBe(200)
    const updated = (await update.json()) as {
      item: { statement: string; verificationState: string }
    }
    expect(updated.item).toMatchObject({
      statement: 'User prefers the built-in editor for routine drafts.',
      verificationState: 'user_confirmed',
    })

    const detail = await app.request(
      `/v1/assistants/${assistant.id}/memory-items/${created.item.id}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(detail.status).toBe(200)

    const deleted = await app.request(
      `/v1/assistants/${assistant.id}/memory-items/${created.item.id}`,
      {
        method: 'DELETE',
        headers: { 'X-Workspace-Token': token },
      },
    )
    expect(deleted.status).toBe(204)

    const afterDelete = await app.request(
      `/v1/assistants/${assistant.id}/memory-items/${created.item.id}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(afterDelete.status).toBe(404)
  })

  it('scopes memory items by workspace and assistant', async () => {
    const { app } = await freshApp()
    const tokenA = await signTestToken('00000000-0000-4000-8000-000000000001')
    const tokenB = await signTestToken('00000000-0000-4000-8000-000000000002')
    const assistantA = await hatchAssistant(app, tokenA)
    const assistantB = await hatchAssistant(app, tokenB)

    const create = await app.request(`/v1/assistants/${assistantA.id}/memory-items`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': tokenA,
      },
      body: JSON.stringify({
        kind: 'semantic',
        subject: 'scoped',
        statement: 'Only workspace A can read this.',
      }),
    })
    const created = (await create.json()) as { item: { id: string } }

    const crossWorkspace = await app.request(
      `/v1/assistants/${assistantA.id}/memory-items/${created.item.id}`,
      { headers: { 'X-Workspace-Token': tokenB } },
    )
    expect(crossWorkspace.status).toBe(404)

    const crossAssistant = await app.request(
      `/v1/assistants/${assistantB.id}/memory-items/${created.item.id}`,
      { headers: { 'X-Workspace-Token': tokenB } },
    )
    expect(crossAssistant.status).toBe(404)
  })

  it('lists and fetches memory v2 concept pages', async () => {
    const { app, memoryRepo } = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000001')
    const assistant = await hatchAssistant(app, token)

    memoryRepo.__upsertConceptPage({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      accountId: 'acct-memory-test',
      assistantId: assistant.id,
      slug: 'preferences/editor',
      rendered: '# Editor\n\nUser prefers the built-in editor.',
      edgeCount: 2,
    })

    const list = await app.request(
      `/v1/assistants/${assistant.id}/memory/v2/list-concept-pages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({}),
      },
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as {
      pages: Array<{ slug: string; bodyBytes: number; edgeCount: number; updatedAtMs: number }>
    }
    expect(listed.pages).toEqual([
      expect.objectContaining({
        slug: 'preferences/editor',
        edgeCount: 2,
      }),
    ])
    expect(listed.pages[0]!.bodyBytes).toBeGreaterThan(0)
    expect(typeof listed.pages[0]!.updatedAtMs).toBe('number')

    const detail = await app.request(
      `/v1/assistants/${assistant.id}/memory/v2/concept-page`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ slug: 'preferences/editor' }),
      },
    )
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      slug: 'preferences/editor',
      rendered: '# Editor\n\nUser prefers the built-in editor.',
    })
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  const root = await mkdtemp(join(tmpdir(), 'basics-compat-'))
  process.env.WORKSPACE_ROOT_BASE = root

  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()

  const desktopAssistants = await import('../orchestrator/desktopAssistantsRepo.js')
  desktopAssistants.__setDesktopAssistantsRepoForTests(
    desktopAssistants.createMemoryDesktopAssistantsRepo(),
  )

  const { buildApp } = await import('../app.js')
  const app = buildApp()
  return {
    app,
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
      delete process.env.WORKSPACE_ROOT_BASE
      __resetConfigForTests()
    },
  }
}

async function signTestToken(workspaceId: string, accountId = 'acct-compat-test') {
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
  const res = await app.request('/v1/assistants/hatch/?mode=create', {
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

describe('assistant compatibility parity routes', () => {
  it('persists feature flags, privacy config, and thresholds per assistant', async () => {
    const ctx = await freshApp()
    try {
      const token = await signTestToken('00000000-0000-4000-8000-000000000101')
      const assistant = await hatchAssistant(ctx.app, token)

      const setFlag = await ctx.app.request(
        `/v1/assistants/${assistant.id}/feature-flags/browser`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
          body: JSON.stringify({ enabled: false }),
        },
      )
      expect(setFlag.status).toBe(200)

      const flags = await ctx.app.request(`/v1/assistants/${assistant.id}/feature-flags`, {
        headers: { 'X-Workspace-Token': token },
      })
      expect(flags.status).toBe(200)
      const flagsBody = (await flags.json()) as { flags: Array<{ key: string; enabled: boolean }> }
      expect(flagsBody.flags.find((flag) => flag.key === 'browser')?.enabled).toBe(false)

      const privacy = await ctx.app.request(`/v1/assistants/${assistant.id}/config/privacy`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({ collectUsageData: false, llmRequestLogRetentionMs: null }),
      })
      expect(privacy.status).toBe(200)
      expect(await privacy.json()).toMatchObject({
        collectUsageData: false,
        sendDiagnostics: true,
        llmRequestLogRetentionMs: null,
      })

      const thresholds = await ctx.app.request(
        `/v1/assistants/${assistant.id}/permissions/thresholds`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
          body: JSON.stringify({ interactive: 'low', autonomous: 'none', headless: 'none' }),
        },
      )
      expect(thresholds.status).toBe(200)
      expect(await thresholds.json()).toMatchObject({
        interactive: 'low',
        autonomous: 'none',
        headless: 'none',
      })
    } finally {
      await ctx.cleanup()
    }
  })

  it('backs workspace file routes with a traversal-safe filesystem namespace', async () => {
    const ctx = await freshApp()
    try {
      const token = await signTestToken('00000000-0000-4000-8000-000000000102')
      const assistant = await hatchAssistant(ctx.app, token)

      const write = await ctx.app.request(`/v1/assistants/${assistant.id}/workspace/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({ path: 'notes/today.md', content: 'hello cloud workspace' }),
      })
      expect(write.status).toBe(200)

      const content = await ctx.app.request(
        `/v1/assistants/${assistant.id}/workspace/file/content?path=notes/today.md`,
        { headers: { 'X-Workspace-Token': token } },
      )
      expect(content.status).toBe(200)
      expect(await content.text()).toBe('hello cloud workspace')

      const tree = await ctx.app.request(
        `/v1/assistants/${assistant.id}/workspace/tree?path=notes`,
        { headers: { 'X-Workspace-Token': token } },
      )
      expect(tree.status).toBe(200)
      expect(await tree.json()).toMatchObject({
        path: 'notes',
        entries: [expect.objectContaining({ path: 'notes/today.md', type: 'file' })],
      })

      const workspaceFiles = await ctx.app.request(
        `/v1/assistants/${assistant.id}/workspace-files`,
        { headers: { 'X-Workspace-Token': token } },
      )
      expect(workspaceFiles.status).toBe(200)
      expect(await workspaceFiles.json()).toMatchObject({
        type: 'workspace_files_list_response',
        files: [
          expect.objectContaining({
            path: 'notes/today.md',
            name: 'today.md',
            exists: true,
          }),
        ],
      })

      const workspaceFilesSlash = await ctx.app.request(
        `/v1/assistants/${assistant.id}/workspace-files/`,
        { headers: { 'X-Workspace-Token': token } },
      )
      expect(workspaceFilesSlash.status).toBe(200)
      expect(await workspaceFilesSlash.json()).toMatchObject({
        type: 'workspace_files_list_response',
        files: [
          expect.objectContaining({
            path: 'notes/today.md',
            name: 'today.md',
            exists: true,
          }),
        ],
      })

      const traversal = await ctx.app.request(
        `/v1/assistants/${assistant.id}/workspace/file/content?path=../secret.txt`,
        { headers: { 'X-Workspace-Token': token } },
      )
      expect(traversal.status).toBe(400)
    } finally {
      await ctx.cleanup()
    }
  })

  it('stores documents, apps, and routines without leaking across assistants', async () => {
    const ctx = await freshApp()
    try {
      const token = await signTestToken('00000000-0000-4000-8000-000000000103')
      const first = await hatchAssistant(ctx.app, token)
      const second = await hatchAssistant(ctx.app, token)

      const saveDoc = await ctx.app.request(`/v1/assistants/${first.id}/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({
          surfaceId: 'doc-1',
          conversationId: 'conv-1',
          title: 'Example Document',
          content: 'Document body',
          wordCount: 2,
        }),
      })
      expect(saveDoc.status).toBe(200)

      const doc = await ctx.app.request(`/v1/assistants/${first.id}/documents/doc-1`, {
        headers: { 'X-Workspace-Token': token },
      })
      expect(doc.status).toBe(200)
      expect(await doc.json()).toMatchObject({
        success: true,
        surfaceId: 'doc-1',
        content: 'Document body',
      })

      const otherDoc = await ctx.app.request(`/v1/assistants/${second.id}/documents/doc-1`, {
        headers: { 'X-Workspace-Token': token },
      })
      expect(otherDoc.status).toBe(404)

      const createApp = await ctx.app.request(`/v1/assistants/${first.id}/apps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({
          appId: 'app-1',
          conversationId: 'conv-1',
          name: 'Example App',
          html: '<main>Example</main>',
        }),
      })
      expect(createApp.status).toBe(201)

      const openApp = await ctx.app.request(`/v1/assistants/${first.id}/apps/app-1/open`, {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      })
      expect(openApp.status).toBe(200)
      expect(await openApp.json()).toMatchObject({
        appId: 'app-1',
        name: 'Example App',
        html: '<main>Example</main>',
      })

      const createRoutine = await ctx.app.request(`/v1/assistants/${first.id}/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({ title: 'Example Routine', metadata: { conversationId: 'conv-1' } }),
      })
      expect(createRoutine.status).toBe(201)
      const createdRoutine = (await createRoutine.json()) as { routine: { id: string } }

      const updateRoutine = await ctx.app.request(
        `/v1/assistants/${first.id}/routines/${createdRoutine.routine.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
          body: JSON.stringify({ title: 'Updated Routine' }),
        },
      )
      expect(updateRoutine.status).toBe(200)
      expect(await updateRoutine.json()).toMatchObject({
        routine: { title: 'Updated Routine' },
      })

      const secondRoutines = await ctx.app.request(`/v1/assistants/${second.id}/routines`, {
        headers: { 'X-Workspace-Token': token },
      })
      expect(secondRoutines.status).toBe(200)
      expect(await secondRoutines.json()).toEqual({ routines: [] })
    } finally {
      await ctx.cleanup()
    }
  })
})

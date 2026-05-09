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

async function freshApp(opts: { failAfterPartial?: boolean } = {}) {
  vi.doMock('../lib/gemini.js', () => ({
    getGeminiClientForWorkspace: vi.fn(async () => ({
      credentialId: 'cred-test',
      provenance: 'customer_byok',
      genai: {
        models: {
          generateContentStream: vi.fn(async function* () {
            if (opts.failAfterPartial) {
              yield { text: 'Partial ', usageMetadata: { promptTokenCount: 10 } }
              throw new Error('provider exploded')
            }
            yield { text: 'Hello ', usageMetadata: { promptTokenCount: 10 } }
            yield { text: 'there', usageMetadata: { candidatesTokenCount: 2 } }
          }),
        },
      },
    })),
  }))
  vi.doMock('../lib/metering.js', () => ({
    recordLlmProxyUsage: vi.fn(async () => undefined),
  }))

  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()

  const desktopAssistants = await import('../orchestrator/desktopAssistantsRepo.js')
  desktopAssistants.__setDesktopAssistantsRepoForTests(
    desktopAssistants.createMemoryDesktopAssistantsRepo(),
  )

  const cloudChat = await import('../orchestrator/cloudChatRepo.js')
  cloudChat.__setCloudChatRepoForTests(cloudChat.createMemoryCloudChatRepo())

  const { buildApp } = await import('../app.js')
  return buildApp()
}

async function signTestToken(workspaceId: string, accountId = 'acct-chat-test') {
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

async function hatchAssistant(app: Awaited<ReturnType<typeof freshApp>>, token: string) {
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

function sseJsonLines(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>)
}

describe('managed cloud chat routes', () => {
  it('serves assistant-scoped health for managed desktop connection checks', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000001')
    const assistant = await hatchAssistant(app, token)

    const health = await app.request(`/v1/assistants/${assistant.id}/health/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(health.status).toBe(200)
    const body = (await health.json()) as {
      ok: boolean
      version: string
      assistantId: string
    }
    expect(body).toMatchObject({
      ok: true,
      version: 'runtime',
      assistantId: assistant.id,
    })

    const missing = await app.request(
      '/v1/assistants/00000000-0000-4000-8000-000000000099/health/',
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(missing.status).toBe(404)
  })

  it('streams desktop-compatible frames and persists history', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000001')
    const assistant = await hatchAssistant(app, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'local-conv-1',
        content: 'Say hello',
        sourceChannel: 'vellum',
        interface: 'macos',
        clientMessageId: 'client-msg-1',
      }),
    })
    expect(send.status).toBe(200)
    expect(send.headers.get('content-type')).toContain('text/event-stream')

    const frames = sseJsonLines(await send.text())
    expect(frames.map((f) => f.type)).toEqual([
      'user_message_echo',
      'assistant_text_delta',
      'assistant_text_delta',
      'message_complete',
    ])
    expect(frames[0]).toMatchObject({
      type: 'user_message_echo',
      text: 'Say hello',
      clientMessageId: 'client-msg-1',
    })
    const conversationId = frames[0]!.conversationId as string
    expect(frames[1]).toMatchObject({
      type: 'assistant_text_delta',
      conversationId,
      text: 'Hello ',
    })

    const history = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${conversationId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(history.status).toBe(200)
    const historyBody = (await history.json()) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(historyBody.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there'],
    ])

    const list = await app.request(`/v1/assistants/${assistant.id}/conversations`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as {
      conversations: Array<{ id: string; title: string }>
    }
    expect(listBody.conversations).toHaveLength(1)
    expect(listBody.conversations[0]).toMatchObject({
      id: conversationId,
      title: 'Say hello',
    })

    const slashHistory = await app.request(
      `/v1/assistants/${assistant.id}/messages/?conversationId=${conversationId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(slashHistory.status).toBe(200)

    const slashList = await app.request(
      `/v1/assistants/${assistant.id}/conversations/`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(slashList.status).toBe(200)

    const reorder = await app.request(
      `/v1/assistants/${assistant.id}/conversations/reorder/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          updates: [{ conversationId, isPinned: false }],
        }),
      },
    )
    expect(reorder.status).toBe(200)

    const seen = await app.request(
      `/v1/assistants/${assistant.id}/conversations/seen/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({ conversationId }),
      },
    )
    expect(seen.status).toBe(200)
  })

  it('reuses the mapped conversation key for follow-up messages', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000002')
    const assistant = await hatchAssistant(app, token)

    async function send(content: string) {
      const res = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'X-Workspace-Token': token,
        },
        body: JSON.stringify({
          conversationKey: 'same-local-id',
          content,
          sourceChannel: 'vellum',
          interface: 'macos',
        }),
      })
      expect(res.status).toBe(200)
      return sseJsonLines(await res.text())[0]!.conversationId
    }

    const firstId = await send('First')
    const secondId = await send('Second')
    expect(secondId).toBe(firstId)

    const history = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${firstId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    const body = (await history.json()) as { messages: Array<{ role: string }> }
    expect(body.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
  })

  it('scopes conversations by workspace and supports rename', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('00000000-0000-4000-8000-000000000003')
    const otherToken = await signTestToken('00000000-0000-4000-8000-000000000004')
    const assistant = await hatchAssistant(app, ownerToken)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': ownerToken,
      },
      body: JSON.stringify({
        conversationKey: 'rename-conv',
        content: 'Original title',
      }),
    })
    const conversationId = sseJsonLines(await send.text())[0]!.conversationId

    const denied = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${conversationId}`,
      { headers: { 'X-Workspace-Token': otherToken } },
    )
    expect(denied.status).toBe(404)

    const renamed = await app.request(
      `/v1/assistants/${assistant.id}/conversations/${conversationId}/name/`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'X-Workspace-Token': ownerToken,
        },
        body: JSON.stringify({ name: 'Renamed conversation' }),
      },
    )
    expect(renamed.status).toBe(200)
    const body = (await renamed.json()) as { title: string }
    expect(body.title).toBe('Renamed conversation')
  })

  it('persists partial assistant text and emits a recoverable error frame', async () => {
    const app = await freshApp({ failAfterPartial: true })
    const token = await signTestToken('00000000-0000-4000-8000-000000000005')
    const assistant = await hatchAssistant(app, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'failing-conv',
        content: 'Please fail',
        clientMessageId: 'client-fail-1',
      }),
    })
    expect(send.status).toBe(200)
    const frames = sseJsonLines(await send.text())
    expect(frames.map((f) => f.type)).toEqual([
      'user_message_echo',
      'assistant_text_delta',
      'conversation_error',
    ])
    expect(frames[2]).toMatchObject({
      type: 'conversation_error',
      retryable: true,
      errorCategory: 'cloud_chat',
    })

    const conversationId = frames[0]!.conversationId as string
    const history = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${conversationId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(history.status).toBe(200)
    const body = (await history.json()) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Please fail'],
      ['assistant', 'Partial '],
    ])
  })
})

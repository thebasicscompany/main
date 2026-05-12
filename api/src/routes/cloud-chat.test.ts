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
  vi.restoreAllMocks()
  vi.resetModules()
  process.env.COMPOSIO_API_KEY = ''
  process.env.BASICS_COMPOSIO_API_KEY = ''
})

async function freshApp(
  opts: {
    failAfterPartial?: boolean
    useActualRunner?: boolean
    provider?: {
      stream(input: {
        messages: Array<{ role: string; content: string }>
        tools: Array<{ name: string }>
      }): AsyncIterable<Record<string, unknown>>
    }
  } = {},
) {
  vi.doMock('../orchestrator/managedLlmGatewayProvider.js', () => ({
    managedLlmGatewayProvider: opts.provider ?? {},
  }))
  if (opts.useActualRunner) {
    vi.doUnmock('../orchestrator/managedAssistantRunner.js')
  } else {
    vi.doMock('../orchestrator/managedAssistantRunner.js', async () => {
      const actual = await vi.importActual('../orchestrator/managedAssistantRunner.js')
      return {
        ...actual,
        setDefaultManagedAssistantProvider: vi.fn(),
        async *runManagedAssistant() {
          if (opts.failAfterPartial) {
            yield { type: 'text_delta', text: 'Partial ' }
            throw new Error('provider exploded')
          }
          yield { type: 'text_delta', text: 'Hello ' }
          yield { type: 'text_delta', text: 'there' }
          yield {
            type: 'done',
            model: 'claude-sonnet-4-5',
            tokensInput: 10,
            tokensOutput: 2,
          }
        },
      }
    })
  }

  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()

  const desktopAssistants = await import('../orchestrator/desktopAssistantsRepo.js')
  desktopAssistants.__setDesktopAssistantsRepoForTests(
    desktopAssistants.createMemoryDesktopAssistantsRepo(),
  )

  const cloudChat = await import('../orchestrator/cloudChatRepo.js')
  cloudChat.__setCloudChatRepoForTests(cloudChat.createMemoryCloudChatRepo())
  const hostBridge = await import('../orchestrator/managedHostBridge.js')
  hostBridge.__resetManagedHostBridgeForTests()
  const eventHub = await import('../orchestrator/cloudChatEventHub.js')
  eventHub.__resetCloudChatEventHubForTests()

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

async function openEventStream(
  app: Awaited<ReturnType<typeof freshApp>>,
  assistantId: string,
  token: string,
  headers: Record<string, string> = {},
) {
  const res = await app.request(`/v1/assistants/${assistantId}/events/`, {
    headers: {
      'X-Workspace-Token': token,
      'X-Basics-Client-Id': 'test-client',
      'X-Basics-Interface-Id': 'macos',
      ...headers,
    },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(res.body).toBeTruthy()

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Array<Record<string, unknown>> = []

  async function readChunk(timeoutMs = 2_000) {
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out reading SSE frame')), timeoutMs),
      ),
    ])
    if (!read.done) buffer += decoder.decode(read.value, { stream: true })
    return read
  }

  function drainFrames() {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match) break
      const rawFrame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const data = rawFrame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n')
      if (!data) continue
      const event = JSON.parse(data) as Record<string, unknown>
      expect(event).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          emittedAt: expect.any(String),
          message: expect.any(Object),
        }),
      )
      const message = event.message as Record<string, unknown>
      expect(message.type).toEqual(expect.any(String))
      frames.push(message)
    }
  }

  await readChunk()
  expect(buffer).toContain(': heartbeat')
  drainFrames()

  async function readUntil(
    predicate: (frames: Array<Record<string, unknown>>) => boolean,
    timeoutMs = 2_000,
  ) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const read = await readChunk(remaining)
      if (read.done) break
      drainFrames()

      if (predicate(frames)) return frames
    }
    throw new Error(`timed out waiting for SSE frames; saw ${JSON.stringify(frames)}`)
  }

  return {
    readUntil,
    close: async () => {
      await reader.cancel().catch(() => undefined)
    },
  }
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

  it('accepts messages as JSON and publishes desktop-compatible frames over events', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000001')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
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
    expect(send.status).toBe(202)
    expect(send.headers.get('content-type')).toContain('application/json')
    const accepted = (await send.json()) as {
      accepted: boolean
      messageId: string
      conversationId: string
    }
    expect(accepted).toMatchObject({ accepted: true })

    const frames = await events.readUntil((seen) => seen.some((f) => f.type === 'message_complete'))
    expect(frames.map((f) => f.type)).toEqual([
      'user_message_echo',
      'assistant_text_delta',
      'assistant_text_delta',
      'message_complete',
    ])
    expect(frames[0]).toMatchObject({
      type: 'user_message_echo',
      text: 'Say hello',
      conversationId: accepted.conversationId,
      messageId: accepted.messageId,
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

    const slashList = await app.request(`/v1/assistants/${assistant.id}/conversations/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(slashList.status).toBe(200)

    const reorder = await app.request(`/v1/assistants/${assistant.id}/conversations/reorder/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        updates: [{ conversationId, isPinned: false }],
      }),
    })
    expect(reorder.status).toBe(200)

    const seen = await app.request(`/v1/assistants/${assistant.id}/conversations/seen/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ conversationId }),
    })
    expect(seen.status).toBe(200)
    await events.close()
  })

  it('reuses the mapped conversation key for follow-up messages', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000002')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)
    let completesSeen = 0

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
      expect(res.status).toBe(202)
      const body = (await res.json()) as { conversationId: string }
      completesSeen += 1
      await events.readUntil(
        (frames) =>
          frames.filter(
            (f) => f.type === 'message_complete' && f.conversationId === body.conversationId,
          ).length >= completesSeen,
      )
      return body.conversationId
    }

    const firstId = await send('First')
    const secondId = await send('Second')
    expect(secondId).toBe(firstId)

    const history = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${firstId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    const body = (await history.json()) as { messages: Array<{ role: string }> }
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    await events.close()
  })

  it('reuses the same conversation when follow-up uses the server conversation id', async () => {
    const providerInputs: Array<{
      messages: Array<{ role: string; content: string }>
      tools: Array<{ name: string }>
    }> = []
    const app = await freshApp({
      useActualRunner: true,
      provider: {
        async *stream(input) {
          providerInputs.push({
            messages: input.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            tools: input.tools,
          })
          yield { type: 'text_delta', text: `reply-${providerInputs.length}` }
        },
      },
    })
    const token = await signTestToken('00000000-0000-4000-8000-000000000008')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const first = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'local-synthetic-conv',
        content: 'List the files in this folder.',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    })
    expect(first.status).toBe(202)
    const firstBody = (await first.json()) as { conversationId: string }
    await events.readUntil((frames) =>
      frames.some(
        (f) => f.type === 'message_complete' && f.conversationId === firstBody.conversationId,
      ),
    )

    const second = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: firstBody.conversationId,
        content: 'Why can’t you do it?',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    })
    expect(second.status).toBe(202)
    const secondBody = (await second.json()) as { conversationId: string }
    expect(secondBody.conversationId).toBe(firstBody.conversationId)
    await events.readUntil(
      (frames) =>
        frames.filter(
          (f) => f.type === 'message_complete' && f.conversationId === firstBody.conversationId,
        ).length >= 2,
    )

    expect(providerInputs[1]!.messages.map((message) => [message.role, message.content])).toEqual([
      ['system', expect.any(String)],
      ['user', 'List the files in this folder.'],
      ['assistant', 'reply-1'],
      ['user', 'Why can’t you do it?'],
    ])
    await events.close()
  })

  it('scopes conversations by workspace and supports rename', async () => {
    const app = await freshApp()
    const ownerToken = await signTestToken('00000000-0000-4000-8000-000000000003')
    const otherToken = await signTestToken('00000000-0000-4000-8000-000000000004')
    const assistant = await hatchAssistant(app, ownerToken)
    const events = await openEventStream(app, assistant.id, ownerToken)

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
    const { conversationId } = (await send.json()) as { conversationId: string }
    await events.readUntil((frames) =>
      frames.some((f) => f.type === 'message_complete' && f.conversationId === conversationId),
    )

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
    await events.close()
  })

  it('supports managed conversation detail, archive, unarchive, delete, and clear operations', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000013')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'archive-conv',
        content: 'Archive this conversation',
      }),
    })
    expect(send.status).toBe(202)
    const { conversationId } = (await send.json()) as { conversationId: string }
    await events.readUntil((frames) =>
      frames.some((f) => f.type === 'message_complete' && f.conversationId === conversationId),
    )

    const detail = await app.request(
      `/v1/assistants/${assistant.id}/conversations/${conversationId}/`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      conversation: { id: conversationId, archived: false },
    })

    const archived = await app.request(
      `/v1/assistants/${assistant.id}/conversations/${conversationId}/archive/`,
      { method: 'POST', headers: { 'X-Workspace-Token': token } },
    )
    expect(archived.status).toBe(200)
    await expect(archived.json()).resolves.toMatchObject({
      id: conversationId,
      archived: true,
    })

    const listAfterArchive = await app.request(`/v1/assistants/${assistant.id}/conversations/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(listAfterArchive.status).toBe(200)
    await expect(listAfterArchive.json()).resolves.toMatchObject({ conversations: [] })

    const unarchived = await app.request(
      `/v1/assistants/${assistant.id}/conversations/${conversationId}/unarchive/`,
      { method: 'POST', headers: { 'X-Workspace-Token': token } },
    )
    expect(unarchived.status).toBe(200)
    await expect(unarchived.json()).resolves.toMatchObject({
      id: conversationId,
      archived: false,
    })

    const deleted = await app.request(
      `/v1/assistants/${assistant.id}/conversations/${conversationId}/`,
      { method: 'DELETE', headers: { 'X-Workspace-Token': token } },
    )
    expect(deleted.status).toBe(200)

    const missingMessages = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${conversationId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(missingMessages.status).toBe(404)

    const first = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ conversationKey: 'clear-one', content: 'First' }),
    })
    const firstBody = (await first.json()) as { conversationId: string }
    const second = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({ conversationKey: 'clear-two', content: 'Second' }),
    })
    const secondBody = (await second.json()) as { conversationId: string }
    await events.readUntil((frames) =>
      [firstBody.conversationId, secondBody.conversationId].every((id) =>
        frames.some((f) => f.type === 'message_complete' && f.conversationId === id),
      ),
    )

    const cleared = await app.request(`/v1/assistants/${assistant.id}/conversations/`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    })
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toMatchObject({ success: true, deletedCount: 2 })

    const listAfterClear = await app.request(`/v1/assistants/${assistant.id}/conversations/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(listAfterClear.status).toBe(200)
    await expect(listAfterClear.json()).resolves.toMatchObject({ conversations: [] })
    await events.close()
  })

  it('supports managed conversation undo and emits a desktop-compatible undo frame', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000014')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const first = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'undo-conv',
        content: 'First',
      }),
    })
    const firstBody = (await first.json()) as { conversationId: string }
    await events.readUntil((frames) =>
      frames.some(
        (f) => f.type === 'message_complete' && f.conversationId === firstBody.conversationId,
      ),
    )

    const second = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: firstBody.conversationId,
        content: 'Second',
      }),
    })
    expect(second.status).toBe(202)
    await events.readUntil(
      (frames) =>
        frames.filter(
          (f) => f.type === 'message_complete' && f.conversationId === firstBody.conversationId,
        ).length >= 2,
    )

    const undone = await app.request(
      `/v1/assistants/${assistant.id}/conversations/${firstBody.conversationId}/undo/`,
      { method: 'POST', headers: { 'X-Workspace-Token': token } },
    )
    expect(undone.status).toBe(200)
    await expect(undone.json()).resolves.toMatchObject({
      conversationId: firstBody.conversationId,
      removedCount: 2,
    })
    const undoFrames = await events.readUntil((frames) =>
      frames.some(
        (f) => f.type === 'undo_complete' && f.conversationId === firstBody.conversationId,
      ),
    )
    expect(undoFrames.at(-1)).toMatchObject({
      type: 'undo_complete',
      conversationId: firstBody.conversationId,
      removedCount: 2,
    })

    const history = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${firstBody.conversationId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(history.status).toBe(200)
    const body = (await history.json()) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'First'],
      ['assistant', 'Hello there'],
    ])
    await events.close()
  })

  it('persists partial assistant text and emits a recoverable error frame', async () => {
    const app = await freshApp({ failAfterPartial: true })
    const token = await signTestToken('00000000-0000-4000-8000-000000000005')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

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
    expect(send.status).toBe(202)
    const accepted = (await send.json()) as { conversationId: string }
    const frames = await events.readUntil((seen) =>
      seen.some((f) => f.type === 'conversation_error'),
    )
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

    const conversationId = accepted.conversationId
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
    await events.close()
  })

  it('publishes host bash requests over events and completes after result postback', async () => {
    let providerCalls = 0
    const app = await freshApp({
      useActualRunner: true,
      provider: {
        async *stream(input) {
          providerCalls += 1
          if (providerCalls === 1) {
            expect(input.tools.map((tool) => tool.name)).toContain('host_bash')
            yield {
              type: 'tool_call',
              toolCall: {
                id: 'call-pwd',
                name: 'host_bash',
                arguments: { command: 'pwd' },
              },
            }
            return
          }
          expect(input.messages.some((message) => message.role === 'tool')).toBe(true)
          yield {
            type: 'text_delta',
            text: 'The current directory is /Users/example/project.',
          }
        },
      },
    })
    const token = await signTestToken('00000000-0000-4000-8000-000000000006')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'host-tool-conv',
        content: 'Run pwd',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    })
    expect(send.status).toBe(202)
    const accepted = (await send.json()) as { conversationId: string }

    const requestFrames = await events.readUntil((seen) =>
      seen.some((f) => f.type === 'host_bash_request'),
    )
    expect(requestFrames).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_start',
        toolName: 'bash',
        input: { command: 'pwd' },
        conversationId: accepted.conversationId,
        toolUseId: 'call-pwd',
      }),
    )
    const hostRequest = requestFrames.find((f) => f.type === 'host_bash_request')
    expect(hostRequest).toMatchObject({
      type: 'host_bash_request',
      requestId: 'call-pwd',
      conversationId: accepted.conversationId,
      command: 'pwd',
      targetClientId: 'test-client',
    })
    expect(hostRequest).not.toHaveProperty('cwd')

    const deniedResult = await app.request(`/v1/assistants/${assistant.id}/host-bash-result/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
        'X-Basics-Client-Id': 'other-client',
      },
      body: JSON.stringify({
        requestId: hostRequest!.requestId,
        result: {
          exitCode: 0,
          stdout: '/Users/example/project\n',
          stderr: '',
        },
      }),
    })
    expect(deniedResult.status).toBe(404)

    const result = await app.request(`/v1/assistants/${assistant.id}/host-bash-result/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
        'X-Basics-Client-Id': 'test-client',
      },
      body: JSON.stringify({
        requestId: hostRequest!.requestId,
        result: {
          exitCode: 0,
          stdout: '/Users/example/project\n',
          stderr: '',
        },
      }),
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ accepted: true })

    const frames = await events.readUntil((seen) => seen.some((f) => f.type === 'message_complete'))
    expect(frames.map((frame) => frame.type)).toEqual([
      'user_message_echo',
      'tool_use_start',
      'host_bash_request',
      'tool_result',
      'assistant_text_delta',
      'message_complete',
    ])
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolName: 'bash',
        conversationId: accepted.conversationId,
        toolUseId: 'call-pwd',
        isError: false,
      }),
    )

    const history = await app.request(
      `/v1/assistants/${assistant.id}/messages?conversationId=${accepted.conversationId}`,
      { headers: { 'X-Workspace-Token': token } },
    )
    const body = (await history.json()) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Run pwd'],
      ['assistant', 'The current directory is /Users/example/project.'],
    ])
    await events.close()
  })

  it('passes host tools plus Composio proxy tools to normal client chat when configured', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    let sawTools = false
    const app = await freshApp({
      useActualRunner: true,
      provider: {
        async *stream(input) {
          expect(input.tools.map((tool) => tool.name)).toEqual([
            'host_bash',
            'host_file_read',
            'composio_list_tools',
            'composio_execute_tool',
          ])
          sawTools = true
          yield { type: 'text_delta', text: 'Connected tools are available.' }
        },
      },
    })
    const token = await signTestToken('00000000-0000-4000-8000-000000000016')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'host-composio-tool-conv',
        content: 'What tools can you use?',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    })
    expect(send.status).toBe(202)
    const accepted = (await send.json()) as { conversationId: string }

    const frames = await events.readUntil((seen) => seen.some((f) => f.type === 'message_complete'))
    expect(sawTools).toBe(true)
    expect(frames.map((frame) => frame.type)).toEqual([
      'user_message_echo',
      'assistant_text_delta',
      'message_complete',
    ])
    expect(frames.at(-1)).toMatchObject({
      type: 'message_complete',
      conversationId: accepted.conversationId,
    })
    await events.close()
  })

  it('emits normal tool frames for API-side Composio tool calls without secrets', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const requestUrl = String(url)
        if (requestUrl.includes('/auth_configs?')) {
          return Response.json({
            items: [{ id: 'auth-github', status: 'ENABLED', toolkit: { slug: 'github' } }],
          })
        }
        if (requestUrl.includes('/connected_accounts?')) {
          return Response.json({
            items: [{ id: 'conn-github', status: 'ACTIVE', auth_config: { id: 'auth-github' } }],
          })
        }
        if (requestUrl.includes('/tools?')) {
          return Response.json({
            items: [{ slug: 'github_list_repos', auth_config: { id: 'auth-github' } }],
          })
        }
        if (requestUrl.endsWith('/tools/execute/github_list_repos')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            user_id: 'acct-chat-test',
            connected_account_id: 'conn-github',
          })
          return Response.json({ repos: ['example-repo'] })
        }
        throw new Error(`Unexpected Composio fetch: ${requestUrl}`)
      }),
    )
    let providerCalls = 0
    const app = await freshApp({
      useActualRunner: true,
      provider: {
        async *stream(input) {
          providerCalls += 1
          if (providerCalls === 1) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: 'call-composio',
                name: 'composio_execute_tool',
                arguments: { slug: 'github_list_repos', arguments: {} },
              },
            }
            return
          }
          expect(input.messages.some((message) => message.role === 'tool')).toBe(true)
          yield { type: 'text_delta', text: 'Found example-repo.' }
        },
      },
    })
    const token = await signTestToken('00000000-0000-4000-8000-000000000017')
    const assistant = await hatchAssistant(app, token)
    const events = await openEventStream(app, assistant.id, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'composio-tool-conv',
        content: 'List repos',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    })
    expect(send.status).toBe(202)
    const accepted = (await send.json()) as { conversationId: string }

    const frames = await events.readUntil((seen) => seen.some((f) => f.type === 'message_complete'))
    expect(frames.map((frame) => frame.type)).toEqual([
      'user_message_echo',
      'tool_use_start',
      'tool_result',
      'assistant_text_delta',
      'message_complete',
    ])
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_start',
        toolName: 'composio_execute_tool',
        input: { slug: 'github_list_repos', arguments: {} },
        conversationId: accepted.conversationId,
        toolUseId: 'call-composio',
      }),
    )
    const toolResult = frames.find((frame) => frame.type === 'tool_result')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      toolName: 'composio_execute_tool',
      result: JSON.stringify({ repos: ['example-repo'] }),
      isError: false,
      conversationId: accepted.conversationId,
      toolUseId: 'call-composio',
    })
    expect(JSON.stringify(frames)).not.toContain('test-composio-key')
    await events.close()
  })

  it('serves assistant-scoped compatibility routes instead of raw not_found', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url)
      if (value.includes('/toolkits')) {
        return new Response(
          JSON.stringify({
            items: [{ slug: 'github', name: 'GitHub', meta: { logo: 'logo' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (value.includes('/auth_configs')) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'auth-github', name: 'GitHub', toolkit: { slug: 'github' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (value.includes('/connected_accounts?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'conn-github',
                status: 'ACTIVE',
                auth_config: { id: 'auth-github' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000007')
    const assistant = await hatchAssistant(app, token)

    const skills = await app.request(`/v1/assistants/${assistant.id}/skills/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(skills.status).toBe(200)
    const skillsBody = (await skills.json()) as {
      origin: string
      skills: Array<{ name: string; origin: string; status: string }>
    }
    expect(skillsBody.origin).toBe('basics')
    expect(skillsBody.skills.length).toBeGreaterThan(0)
    expect(skillsBody.skills[0]!.origin).toBe('basics')
    expect(skillsBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'macos-automation',
        kind: 'bundled',
        status: 'enabled',
      }),
    )
    expect(skillsBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'google-calendar',
        kind: 'catalog',
        status: 'available',
      }),
    )
    expect(skillsBody.skills).toContainEqual(
      expect.objectContaining({
        id: 'composio-github',
        name: 'GitHub',
        kind: 'installed',
        origin: 'composio',
        status: 'enabled',
        connectionStatus: 'connected',
        connectedAccountId: 'conn-github',
      }),
    )
    expect(skillsBody.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(['macos-automation', 'google-calendar', 'GitHub']),
    )

    const readiness = await app.request(`/v1/assistants/${assistant.id}/channels/readiness/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(readiness.status).toBe(200)
    expect(await readiness.json()).toMatchObject({
      ready: false,
      status: 'unavailable',
    })

    const integrations = await app.request(`/v1/assistants/${assistant.id}/integrations/status/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(integrations.status).toBe(200)
    expect(await integrations.json()).toMatchObject({
      status: 'unconfigured',
    })
  })

  it('persists assistant-scoped Composio skill config and reflects disabled skills in list', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url)
      if (value.includes('/toolkits')) {
        return Response.json({ items: [{ slug: 'github', name: 'GitHub' }] })
      }
      if (value.includes('/auth_configs')) {
        return Response.json({
          items: [{ id: 'auth-github', name: 'GitHub', toolkit: { slug: 'github' } }],
        })
      }
      if (value.includes('/connected_accounts?')) {
        return Response.json({
          items: [{ id: 'conn-github', status: 'ACTIVE', auth_config: { id: 'auth-github' } }],
        })
      }
      if (value.includes('/tools?')) {
        return Response.json({
          items: [
            { slug: 'github_create_issue', toolkit: { slug: 'github' } },
            { slug: 'github_list_repos', toolkit: { slug: 'github' } },
          ],
        })
      }
      return Response.json({})
    })
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000019')
    const assistant = await hatchAssistant(app, token)

    const patch = await app.request(
      `/v1/assistants/${assistant.id}/skills/composio-github/config/`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({ enabled: false, disabledToolSlugs: ['github_create_issue'] }),
      },
    )
    expect(patch.status).toBe(200)

    const config = await app.request(
      `/v1/assistants/${assistant.id}/skills/composio-github/config/`,
      {
        headers: { 'X-Workspace-Token': token },
      },
    )
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      skillId: 'composio-github',
      enabled: false,
      disabledToolSlugs: ['github_create_issue'],
      connectedAccountId: 'conn-github',
      tools: [
        expect.objectContaining({ slug: 'github_create_issue', enabled: false }),
        expect.objectContaining({ slug: 'github_list_repos', enabled: false }),
      ],
    })

    const skills = await app.request(`/v1/assistants/${assistant.id}/skills/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(skills.status).toBe(200)
    const body = (await skills.json()) as { skills: Array<{ id: string; status: string }> }
    expect(body.skills).toContainEqual(
      expect.objectContaining({ id: 'composio-github', kind: 'installed', status: 'disabled' }),
    )
  })

  it('returns composio_tool_disabled when managed chat calls a disabled Composio tool', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const requestUrl = String(url)
        if (requestUrl.includes('/toolkits')) {
          return Response.json({ items: [{ slug: 'github', name: 'GitHub' }] })
        }
        if (requestUrl.includes('/auth_configs?')) {
          return Response.json({
            items: [{ id: 'auth-github', status: 'ENABLED', toolkit: { slug: 'github' } }],
          })
        }
        if (requestUrl.includes('/connected_accounts?')) {
          return Response.json({
            items: [{ id: 'conn-github', status: 'ACTIVE', auth_config: { id: 'auth-github' } }],
          })
        }
        if (requestUrl.includes('/tools?')) {
          return Response.json({
            items: [{ slug: 'github_list_repos', auth_config: { id: 'auth-github' } }],
          })
        }
        throw new Error(`Unexpected Composio fetch: ${requestUrl}`)
      }),
    )
    let providerCalls = 0
    const app = await freshApp({
      useActualRunner: true,
      provider: {
        async *stream() {
          providerCalls += 1
          if (providerCalls === 1) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: 'call-composio',
                name: 'composio_execute_tool',
                arguments: { slug: 'github_list_repos', arguments: {} },
              },
            }
            return
          }
          yield { type: 'text_delta', text: 'Tool is disabled.' }
        },
      },
    })
    const token = await signTestToken('00000000-0000-4000-8000-000000000020')
    const assistant = await hatchAssistant(app, token)
    const patch = await app.request(
      `/v1/assistants/${assistant.id}/skills/composio-github/config/`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-Workspace-Token': token },
        body: JSON.stringify({ disabledToolSlugs: ['github_list_repos'] }),
      },
    )
    expect(patch.status).toBe(200)
    const events = await openEventStream(app, assistant.id, token)

    const send = await app.request(`/v1/assistants/${assistant.id}/messages/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        conversationKey: 'disabled-composio-tool-conv',
        content: 'List repos',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    })
    expect(send.status).toBe(202)

    const frames = await events.readUntil((seen) => seen.some((f) => f.type === 'message_complete'))
    const toolResult = frames.find((frame) => frame.type === 'tool_result')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      toolName: 'composio_execute_tool',
      result: expect.stringContaining('composio_tool_disabled'),
    })
    await events.close()
  })

  it('keeps assistant-scoped skills available when Composio discovery fails', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('composio unavailable'))

    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000018')
    const assistant = await hatchAssistant(app, token)

    const skills = await app.request(`/v1/assistants/${assistant.id}/skills/`, {
      headers: { 'X-Workspace-Token': token },
    })

    expect(skills.status).toBe(200)
    const skillsBody = (await skills.json()) as {
      skills: Array<{ name: string; origin: string; status: string }>
    }
    expect(skillsBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'macos-automation',
        origin: 'basics',
        status: 'enabled',
      }),
    )
    expect(skillsBody.skills).not.toContainEqual(
      expect.objectContaining({
        origin: 'composio',
      }),
    )
  })

  it('allows macOS host registration headers in CORS preflight', async () => {
    const app = await freshApp()
    const res = await app.request('/v1/assistants/asst-1/events/', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers':
          'X-Workspace-Token,X-Basics-Client-Id,X-Vellum-Client-Id,X-Basics-Interface-Id,X-Vellum-Interface-Id,X-Basics-Machine-Name,X-Vellum-Machine-Name',
      },
    })
    expect(res.status).toBe(204)
    const allowed = res.headers.get('access-control-allow-headers') ?? ''
    expect(allowed).toContain('X-Basics-Client-Id')
    expect(allowed).toContain('X-Vellum-Client-Id')
    expect(allowed).toContain('X-Basics-Interface-Id')
    expect(allowed).toContain('X-Vellum-Interface-Id')
    expect(allowed).toContain('X-Basics-Machine-Name')
    expect(allowed).toContain('X-Vellum-Machine-Name')
  })
})

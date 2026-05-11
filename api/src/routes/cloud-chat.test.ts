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

    const frames = await events.readUntil((seen) =>
      seen.some((f) => f.type === 'message_complete'),
    )
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
    expect(body.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
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
    const hostRequest = requestFrames.find((f) => f.type === 'host_bash_request')
    expect(hostRequest).toMatchObject({
      type: 'host_bash_request',
      requestId: 'call-pwd',
      conversationId: accepted.conversationId,
      command: 'pwd',
      targetClientId: 'test-client',
    })
    expect(hostRequest).not.toHaveProperty('cwd')

    const deniedResult = await app.request(
      `/v1/assistants/${assistant.id}/host-bash-result/`,
      {
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
      },
    )
    expect(deniedResult.status).toBe(404)

    const result = await app.request(
      `/v1/assistants/${assistant.id}/host-bash-result/`,
      {
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
      },
    )
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ accepted: true })

    const frames = await events.readUntil((seen) =>
      seen.some((f) => f.type === 'message_complete'),
    )
    expect(frames.map((frame) => frame.type)).toEqual([
      'user_message_echo',
      'host_bash_request',
      'assistant_text_delta',
      'message_complete',
    ])

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

  it('serves assistant-scoped compatibility routes instead of raw not_found', async () => {
    const app = await freshApp()
    const token = await signTestToken('00000000-0000-4000-8000-000000000007')
    const assistant = await hatchAssistant(app, token)

    const skills = await app.request(`/v1/assistants/${assistant.id}/skills/`, {
      headers: { 'X-Workspace-Token': token },
    })
    expect(skills.status).toBe(200)
    const skillsBody = (await skills.json()) as {
      origin: string
      skills: Array<{ name: string; origin: string }>
    }
    expect(skillsBody.origin).toBe('vellum')
    expect(skillsBody.skills.length).toBeGreaterThan(0)
    expect(skillsBody.skills[0]!.origin).toBe('vellum')

    const readiness = await app.request(
      `/v1/assistants/${assistant.id}/channels/readiness/`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(readiness.status).toBe(200)
    expect(await readiness.json()).toMatchObject({
      ready: false,
      status: 'unavailable',
    })

    const integrations = await app.request(
      `/v1/assistants/${assistant.id}/integrations/status/`,
      { headers: { 'X-Workspace-Token': token } },
    )
    expect(integrations.status).toBe(200)
    expect(await integrations.json()).toMatchObject({
      status: 'unconfigured',
    })
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

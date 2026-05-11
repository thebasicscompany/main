import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceToken } from '../lib/jwt.js'
import { __resetConfigForTests } from '../config.js'
import { resetComposioConnectionStateForTests } from '../lib/composio.js'
import {
  completeManagedHostRequest,
  registerManagedHostClient,
  __resetManagedHostBridgeForTests,
} from './managedHostBridge.js'
import {
  managedHostToolDefinitions,
  managedComposioToolDefinitions,
  runManagedAssistant,
  type ManagedAssistantProvider,
} from './managedAssistantRunner.js'

const workspace: WorkspaceToken = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  account_id: 'acct-test',
  plan: 'free',
  seat_status: 'active',
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.COMPOSIO_API_KEY = ''
  process.env.BASICS_COMPOSIO_API_KEY = ''
  process.env.COMPOSIO_BASE_URL = 'https://composio.example.test/api'
  __resetConfigForTests()
  __resetManagedHostBridgeForTests()
  resetComposioConnectionStateForTests()
  vi.unstubAllGlobals()
})

describe('managedAssistantRunner', () => {
  it('omits host tools when no capable desktop client is connected', async () => {
    expect(
      managedHostToolDefinitions({
        workspaceId: workspace.workspace_id,
        assistantId: 'assistant-1',
      }),
    ).toEqual([])
  })

  it('omits Composio proxy tools when no Composio key is configured', () => {
    expect(managedComposioToolDefinitions()).toEqual([])
  })

  it('advertises Composio proxy tools when a Composio key is configured', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    __resetConfigForTests()

    const provider: ManagedAssistantProvider = {
      async *stream(input) {
        expect(input.tools.map((tool) => tool.name)).toEqual([
          'composio_list_tools',
          'composio_execute_tool',
        ])
        yield { type: 'text_delta', text: 'No tool needed.' }
      },
    }

    const events = []
    for await (const event of runManagedAssistant({
      workspace,
      assistantId: 'assistant-1',
      requestId: 'req-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'hello' }],
      provider,
    })) {
      events.push(event)
    }

    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('lists only enabled Composio tools with active connected accounts', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    __resetConfigForTests()
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const requestUrl = String(url)
      expect(init?.headers).not.toMatchObject({ authorization: expect.any(String) })
      if (requestUrl.includes('/auth_configs?')) {
        return Response.json({
          items: [
            { id: 'auth-github', status: 'ENABLED', toolkit: { slug: 'github' } },
            { id: 'auth-disabled', status: 'DISABLED', toolkit: { slug: 'slack' } },
            { id: 'auth-expired', status: 'ENABLED', toolkit: { slug: 'gmail' } },
          ],
        })
      }
      if (requestUrl.includes('/connected_accounts?')) {
        expect(requestUrl).toContain('user_ids=acct-test')
        return Response.json({
          items: [
            {
              id: 'conn-github',
              status: 'ACTIVE',
              auth_config: { id: 'auth-github' },
              toolkit: { slug: 'github' },
            },
            {
              id: 'conn-expired',
              status: 'EXPIRED',
              auth_config: { id: 'auth-expired' },
              toolkit: { slug: 'gmail' },
            },
          ],
        })
      }
      if (requestUrl.includes('/tools?')) {
        expect(requestUrl).toContain('auth_config_ids=auth-github')
        return Response.json({
          items: [
            {
              slug: 'github_create_issue',
              description: 'Create a GitHub issue',
              toolkit: { slug: 'github' },
              auth_config: { id: 'auth-github' },
              input_schema: { type: 'object', properties: { title: { type: 'string' } } },
            },
            {
              slug: 'gmail_send_email',
              description: 'Send an email',
              toolkit: { slug: 'gmail' },
              auth_config: { id: 'auth-expired' },
            },
          ],
        })
      }
      throw new Error(`Unexpected Composio fetch: ${requestUrl}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider: ManagedAssistantProvider = {
      async *stream(input) {
        if (!input.messages.some((message) => message.role === 'tool')) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'call-list', name: 'composio_list_tools', arguments: {} },
          }
          return
        }
        const toolMessage = input.messages.find((message) => message.role === 'tool')!
        const payload = JSON.parse(toolMessage.content) as { tools: Array<{ slug: string }> }
        expect(payload.tools.map((tool) => tool.slug)).toEqual(['github_create_issue'])
        yield { type: 'text_delta', text: 'Listed.' }
      },
    }

    const events = []
    for await (const event of runManagedAssistant({
      workspace,
      assistantId: 'assistant-1',
      requestId: 'req-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'what tools are connected?' }],
      provider,
    })) {
      events.push(event)
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        result: expect.objectContaining({ name: 'composio_list_tools' }),
      }),
    )
  })

  it('executes a selected Composio tool with the workspace account id and connected account', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    __resetConfigForTests()
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
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
          items: [
            {
              slug: 'github_create_issue',
              auth_config: { id: 'auth-github' },
              toolkit: { slug: 'github' },
            },
          ],
        })
      }
      if (requestUrl.endsWith('/tools/execute/github_create_issue')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          user_id: 'acct-test',
          connected_account_id: 'conn-github',
          arguments: { title: 'Example issue' },
        })
        return Response.json({ ok: true, id: 'issue-1' })
      }
      throw new Error(`Unexpected Composio fetch: ${requestUrl}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider: ManagedAssistantProvider = {
      async *stream(input) {
        if (!input.messages.some((message) => message.role === 'tool')) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'call-execute',
              name: 'composio_execute_tool',
              arguments: {
                slug: 'github_create_issue',
                arguments: { title: 'Example issue' },
              },
            },
          }
          return
        }
        const toolMessage = input.messages.find((message) => message.role === 'tool')!
        expect(JSON.parse(toolMessage.content)).toEqual({ ok: true, id: 'issue-1' })
        yield { type: 'text_delta', text: 'Created.' }
      },
    }

    const events = []
    for await (const event of runManagedAssistant({
      workspace,
      assistantId: 'assistant-1',
      requestId: 'req-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'create an issue' }],
      provider,
    })) {
      events.push(event)
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        result: expect.objectContaining({
          name: 'composio_execute_tool',
          content: JSON.stringify({ ok: true, id: 'issue-1' }),
        }),
      }),
    )
  })

  it('returns a model-readable Composio error when discovery fails', async () => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key'
    __resetConfigForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream unavailable', { status: 503 })),
    )

    const provider: ManagedAssistantProvider = {
      async *stream(input) {
        if (!input.messages.some((message) => message.role === 'tool')) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'call-list', name: 'composio_list_tools', arguments: {} },
          }
          return
        }
        const toolMessage = input.messages.find((message) => message.role === 'tool')!
        expect(JSON.parse(toolMessage.content)).toMatchObject({
          error: 'composio_discovery_failed',
        })
        yield { type: 'text_delta', text: 'Composio is unavailable.' }
      },
    }

    const events = []
    for await (const event of runManagedAssistant({
      workspace,
      assistantId: 'assistant-1',
      requestId: 'req-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'list composio tools' }],
      provider,
    })) {
      events.push(event)
    }

    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('dispatches a host bash request, accepts the posted result, and continues', async () => {
    const sentFrames: Array<Record<string, unknown>> = []
    registerManagedHostClient({
      workspaceId: workspace.workspace_id,
      assistantId: 'assistant-1',
      clientId: 'client-1',
      interfaceId: 'macos',
      machineName: 'Example Mac',
      send: async (frame) => {
        sentFrames.push(frame)
        setTimeout(() => {
          completeManagedHostRequest(
            String(frame.requestId),
            {
              exitCode: 0,
              stdout: '/Users/example/project\n',
              stderr: '',
            },
            { clientId: 'client-1' },
          )
        }, 0)
      },
    })

    const provider: ManagedAssistantProvider = {
      async *stream(input) {
        if (!input.messages.some((message) => message.role === 'tool')) {
          expect(input.messages[0]).toMatchObject({
            role: 'system',
          })
          expect(input.tools.map((tool) => tool.name)).toEqual(['host_bash', 'host_file_read'])
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'call-1',
              name: 'host_bash',
              arguments: { command: 'pwd' },
            },
          }
          return
        }
        yield { type: 'text_delta', text: 'You are in /Users/example/project.' }
      },
    }

    const events = []
    for await (const event of runManagedAssistant({
      workspace,
      assistantId: 'assistant-1',
      requestId: 'req-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'pwd' }],
      provider,
    })) {
      events.push(event)
    }

    expect(sentFrames[0]).toMatchObject({
      type: 'host_bash_request',
      conversationId: 'conversation-1',
      command: 'pwd',
      targetClientId: 'client-1',
    })
    expect(sentFrames[0]).not.toHaveProperty('cwd')
    expect(events.map((event) => event.type)).toEqual([
      'tool_call',
      'tool_result',
      'text_delta',
      'done',
    ])
  })

  it('continues host tool rounds beyond the previous cloud-only six-loop cap', async () => {
    const sentFrames: Array<Record<string, unknown>> = []
    registerManagedHostClient({
      workspaceId: workspace.workspace_id,
      assistantId: 'assistant-1',
      clientId: 'client-1',
      interfaceId: 'macos',
      machineName: 'Example Mac',
      send: async (frame) => {
        sentFrames.push(frame)
        setTimeout(() => {
          completeManagedHostRequest(
            String(frame.requestId),
            {
              exitCode: 0,
              stdout: `result ${sentFrames.length}\n`,
              stderr: '',
            },
            { clientId: 'client-1' },
          )
        }, 0)
      },
    })

    const provider: ManagedAssistantProvider = {
      async *stream(input) {
        const toolResultCount = input.messages.filter((message) => message.role === 'tool').length
        if (toolResultCount < 7) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `call-${toolResultCount + 1}`,
              name: 'host_bash',
              arguments: { command: `step-${toolResultCount + 1}` },
            },
          }
          return
        }
        yield { type: 'text_delta', text: 'Finished after seven tool rounds.' }
      },
    }

    const events = []
    for await (const event of runManagedAssistant({
      workspace,
      assistantId: 'assistant-1',
      requestId: 'req-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'inspect thoroughly' }],
      provider,
    })) {
      events.push(event)
    }

    expect(sentFrames).toHaveLength(7)
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(7)
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(7)
    expect(events.at(-2)).toMatchObject({
      type: 'text_delta',
      text: 'Finished after seven tool rounds.',
    })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceToken } from '../lib/jwt.js'
import { __resetConfigForTests } from '../config.js'
import {
  completeManagedHostRequest,
  registerManagedHostClient,
  __resetManagedHostBridgeForTests,
} from './managedHostBridge.js'
import {
  managedHostToolDefinitions,
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
  __resetConfigForTests()
  __resetManagedHostBridgeForTests()
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
          expect(input.tools.map((tool) => tool.name)).toEqual([
            'host_bash',
            'host_file_read',
          ])
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
})

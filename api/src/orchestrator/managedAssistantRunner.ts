import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { pickManagedModel } from '../lib/managed-model-routing.js'
import { logger } from '../middleware/logger.js'
import {
  dispatchManagedHostRequest,
  hasManagedHostCapability,
  listManagedHostClients,
} from './managedHostBridge.js'

export type ManagedAssistantMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ManagedAssistantToolCall[]
}

export type ManagedAssistantToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ManagedAssistantToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ManagedAssistantToolResult = {
  toolCallId: string
  name: string
  content: string
}

export type ManagedAssistantStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCall: ManagedAssistantToolCall }
  | { type: 'tool_result'; result: ManagedAssistantToolResult }
  | { type: 'usage'; model?: string; tokensInput?: number; tokensOutput?: number }
  | { type: 'done'; model: string; tokensInput: number; tokensOutput: number }

export interface ManagedAssistantProvider {
  stream(input: {
    workspace: WorkspaceToken
    requestId: string
    provider: string
    model: string
    messages: ManagedAssistantMessage[]
    tools: ManagedAssistantToolDefinition[]
    maxTokens: number
  }): AsyncIterable<ManagedAssistantStreamEvent>
}

const DEFAULT_MAX_TOKENS = 4096
const MAX_TOOL_LOOPS = 6
const MANAGED_SYSTEM_MESSAGE =
  'You are Basics, a desktop assistant running through the Basics cloud transport. Maintain conversational context from the provided message history. When connected host tools are available and the user asks you to inspect the local machine, run shell commands, list files, print the current directory, or read files, use the appropriate host tool instead of saying you cannot access the filesystem.'

function configuredProvider(): string {
  const cfg = getConfig()
  if (cfg.ANTHROPIC_PLATFORM_KEY || cfg.ANTHROPIC_API_KEY) return 'anthropic'
  if (cfg.OPENAI_API_KEY) return 'openai'
  return 'gemini'
}

export function managedHostToolDefinitions(input: {
  workspaceId: string
  assistantId: string
}): ManagedAssistantToolDefinition[] {
  const tools: ManagedAssistantToolDefinition[] = []
  if (
    hasManagedHostCapability({
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      capability: 'host_bash',
    })
  ) {
    tools.push({
      name: 'host_bash',
      description: 'Run a shell command on the connected macOS host.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    })
  }
  if (
    hasManagedHostCapability({
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      capability: 'host_file',
    })
  ) {
    tools.push({
      name: 'host_file_read',
      description: 'Read a text file from the connected macOS host.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    })
  }
  return tools
}

function normalizeToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

async function dispatchTool(input: {
  workspaceId: string
  assistantId: string
  conversationId: string
  call: ManagedAssistantToolCall
}): Promise<ManagedAssistantToolResult> {
  if (input.call.name === 'host_bash') {
    const requestId = input.call.id || randomUUID()
    const result = await dispatchManagedHostRequest({
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      capability: 'host_bash',
      frame: {
        type: 'host_bash_request',
        requestId,
        conversationId: input.conversationId,
        command: input.call.arguments.command,
        working_dir: input.call.arguments.cwd,
      },
    })
    return {
      toolCallId: input.call.id,
      name: input.call.name,
      content: normalizeToolResult(result),
    }
  }

  if (input.call.name === 'host_file_read') {
    const requestId = input.call.id || randomUUID()
    const result = await dispatchManagedHostRequest({
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      capability: 'host_file',
      frame: {
        type: 'host_file_request',
        requestId,
        conversationId: input.conversationId,
        operation: 'read',
        path: input.call.arguments.path,
      },
    })
    return {
      toolCallId: input.call.id,
      name: input.call.name,
      content: normalizeToolResult(result),
    }
  }

  return {
    toolCallId: input.call.id,
    name: input.call.name,
    content: `Unsupported managed host tool: ${input.call.name}`,
  }
}

export async function* runManagedAssistant(input: {
  workspace: WorkspaceToken
  assistantId: string
  requestId: string
  conversationId: string
  messages: ManagedAssistantMessage[]
  provider?: ManagedAssistantProvider
  maxTokens?: number
}): AsyncIterable<ManagedAssistantStreamEvent> {
  const providerName = configuredProvider()
  const model = pickManagedModel(providerName, 'agent')
  const provider = input.provider ?? defaultManagedAssistantProvider
  const messages: ManagedAssistantMessage[] = [
    { role: 'system', content: MANAGED_SYSTEM_MESSAGE },
    ...input.messages,
  ]
  const tools = managedHostToolDefinitions({
    workspaceId: input.workspace.workspace_id,
    assistantId: input.assistantId,
  })
  const hostClients = listManagedHostClients({
    workspaceId: input.workspace.workspace_id,
    assistantId: input.assistantId,
  })
  logger.info(
    {
      requestId: input.requestId,
      workspace_id: input.workspace.workspace_id,
      assistant_id: input.assistantId,
      conversation_id: input.conversationId,
      provider: providerName,
      model,
      history_message_count: input.messages.length,
      host_client_count: hostClients.length,
      host_clients: hostClients.map((client) => ({
        client_id: client.clientId,
        interface_id: client.interfaceId,
        capabilities: client.capabilities,
      })),
      tool_names: tools.map((tool) => tool.name),
    },
    'managed assistant run starting',
  )
  let tokensInput = 0
  let tokensOutput = 0

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const toolCalls: ManagedAssistantToolCall[] = []
    let assistantText = ''
    logger.info(
      {
        requestId: input.requestId,
        workspace_id: input.workspace.workspace_id,
        assistant_id: input.assistantId,
        conversation_id: input.conversationId,
        loop,
        message_count: messages.length,
        tool_names: tools.map((tool) => tool.name),
      },
      'managed assistant provider stream starting',
    )
    for await (const event of provider.stream({
      workspace: input.workspace,
      requestId: input.requestId,
      provider: providerName,
      model,
      messages,
      tools,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    })) {
      if (event.type === 'text_delta') assistantText += event.text
      if (event.type === 'tool_call') {
        toolCalls.push(event.toolCall)
        logger.info(
          {
            requestId: input.requestId,
            workspace_id: input.workspace.workspace_id,
            assistant_id: input.assistantId,
            conversation_id: input.conversationId,
            loop,
            tool_call_id: event.toolCall.id,
            tool_name: event.toolCall.name,
            argument_keys: Object.keys(event.toolCall.arguments),
          },
          'managed assistant tool call received',
        )
      }
      if (event.type === 'usage') {
        tokensInput = event.tokensInput ?? tokensInput
        tokensOutput = event.tokensOutput ?? tokensOutput
      }
      yield event
    }

    if (toolCalls.length === 0) {
      logger.info(
        {
          requestId: input.requestId,
          workspace_id: input.workspace.workspace_id,
          assistant_id: input.assistantId,
          conversation_id: input.conversationId,
          loop,
          assistant_text_chars: assistantText.length,
          tokens_input: tokensInput,
          tokens_output: tokensOutput,
          advertised_tool_count: tools.length,
        },
        'managed assistant provider finished with no tool calls',
      )
      yield { type: 'done', model, tokensInput, tokensOutput }
      return
    }

    messages.push({
      role: 'assistant',
      content: assistantText,
      toolCalls,
    })
    for (const call of toolCalls) {
      logger.info(
        {
          requestId: input.requestId,
          workspace_id: input.workspace.workspace_id,
          assistant_id: input.assistantId,
          conversation_id: input.conversationId,
          tool_call_id: call.id,
          tool_name: call.name,
        },
        'managed assistant dispatching tool call',
      )
      const result = await dispatchTool({
        workspaceId: input.workspace.workspace_id,
        assistantId: input.assistantId,
        conversationId: input.conversationId,
        call,
      })
      messages.push({
        role: 'tool',
        content: result.content,
        toolCallId: result.toolCallId,
      })
      logger.info(
        {
          requestId: input.requestId,
          workspace_id: input.workspace.workspace_id,
          assistant_id: input.assistantId,
          conversation_id: input.conversationId,
          tool_call_id: result.toolCallId,
          tool_name: result.name,
          result_chars: result.content.length,
        },
        'managed assistant tool result ready',
      )
      yield { type: 'tool_result', result }
    }
  }

  throw new Error('Managed assistant exceeded host tool loop limit')
}

let defaultManagedAssistantProvider: ManagedAssistantProvider

export function setDefaultManagedAssistantProvider(provider: ManagedAssistantProvider) {
  defaultManagedAssistantProvider = provider
}

export function __setManagedAssistantProviderForTests(provider: ManagedAssistantProvider) {
  defaultManagedAssistantProvider = provider
}

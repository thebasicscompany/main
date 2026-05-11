import gatewayApp from '../gateway/index.js'
import { getConfig } from '../config.js'
import {
  NoCredentialError,
  resolveGatewayCredential,
} from './credential-resolver.js'
import { logger } from '../middleware/logger.js'
import type {
  ManagedAssistantMessage,
  ManagedAssistantProvider,
  ManagedAssistantToolCall,
  ManagedAssistantToolDefinition,
} from './managedAssistantRunner.js'

const PROVIDERS: Record<string, { kind: string; gatewayProvider: string }> = {
  anthropic: { kind: 'anthropic', gatewayProvider: 'anthropic' },
  openai: { kind: 'openai', gatewayProvider: 'openai' },
  gemini: { kind: 'gemini', gatewayProvider: 'google' },
}

function pooledKeyFor(kind: string): string | undefined {
  const cfg = getConfig()
  switch (kind) {
    case 'anthropic':
      return cfg.ANTHROPIC_PLATFORM_KEY ?? cfg.ANTHROPIC_API_KEY
    case 'openai':
      return cfg.OPENAI_API_KEY
    case 'gemini':
      return cfg.GEMINI_API_KEY
    default:
      return undefined
  }
}

function toOpenAiMessages(messages: ManagedAssistantMessage[]) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      }
    }
    return {
      role: message.role,
      content: message.content,
    }
  })
}

function toOpenAiTools(tools: ManagedAssistantToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

async function callManagedGateway(input: {
  workspaceId: string
  provider: string
  body: unknown
}) {
  const spec = PROVIDERS[input.provider]
  if (!spec) throw new Error(`Unknown managed LLM provider: ${input.provider}`)
  const resolved = await resolveGatewayCredential({
    workspaceId: input.workspaceId,
    kind: spec.kind,
    pooledKey: pooledKeyFor(spec.kind),
  }).catch((err) => {
    if (err instanceof NoCredentialError) {
      throw new Error(`No credential configured for ${spec.kind}`)
    }
    throw err
  })

  const headers = new Headers()
  headers.set('content-type', 'application/json')
  headers.set('x-basics-gw-provider', spec.gatewayProvider)
  headers.set('authorization', `Bearer ${resolved.plaintext}`)
  if (spec.gatewayProvider === 'anthropic') {
    headers.set('x-api-key', resolved.plaintext)
  }
  if (resolved.credentialId) {
    headers.set('x-basics-credential-id', resolved.credentialId)
  }
  headers.set('x-basics-usage-tag', resolved.usageTag)

  const response = await gatewayApp.fetch(
    new Request('http://managed-gateway.local/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
    }),
  )
  if (!response.ok) {
    throw new Error(`Managed LLM gateway returned ${response.status}`)
  }
  return response
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function* parseOpenAiSse(response: Response, input: { requestId: string }) {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const parsed = JSON.parse(data) as {
        model?: string
        choices?: Array<{
          delta?: {
            content?: string
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (parsed.usage) {
        yield {
          type: 'usage' as const,
          model: parsed.model,
          tokensInput: parsed.usage.prompt_tokens,
          tokensOutput: parsed.usage.completion_tokens,
        }
      }
      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta
        if (!delta) continue
        if (delta.content) yield { type: 'text_delta' as const, text: delta.content }
        for (const piece of delta.tool_calls ?? []) {
          const index = piece.index ?? 0
          const existing = toolCalls.get(index) ?? {
            id: piece.id ?? `call_${index}`,
            name: '',
            arguments: '',
          }
          toolCalls.set(index, {
            id: piece.id ?? existing.id,
            name: piece.function?.name ?? existing.name,
            arguments: existing.arguments + (piece.function?.arguments ?? ''),
          })
          logger.info(
            {
              requestId: input.requestId,
              tool_call_index: index,
              has_id: Boolean(piece.id),
              tool_name: piece.function?.name ?? existing.name,
              argument_chunk_chars: piece.function?.arguments?.length ?? 0,
            },
            'managed llm stream tool call chunk',
          )
        }
      }
    }
  }

  for (const call of toolCalls.values()) {
    if (!call.name) continue
    const toolCall: ManagedAssistantToolCall = {
      id: call.id,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
    }
    logger.info(
      {
        requestId: input.requestId,
        tool_call_id: toolCall.id,
        tool_name: toolCall.name,
        argument_chars: call.arguments.length,
        argument_keys: Object.keys(toolCall.arguments),
      },
      'managed llm stream tool call parsed',
    )
    yield { type: 'tool_call' as const, toolCall }
  }
}

export const managedLlmGatewayProvider: ManagedAssistantProvider = {
  async *stream(input) {
    logger.info(
      {
        requestId: input.requestId,
        workspace_id: input.workspace.workspace_id,
        provider: input.provider,
        model: input.model,
        message_count: input.messages.length,
        tool_names: input.tools.map((tool) => tool.name),
        max_tokens: input.maxTokens,
      },
      'managed llm gateway request starting',
    )
    const response = await callManagedGateway({
      workspaceId: input.workspace.workspace_id,
      provider: input.provider,
      body: {
        model: input.model,
        messages: toOpenAiMessages(input.messages),
        stream: true,
        max_tokens: input.maxTokens,
        ...(input.tools.length > 0 ? { tools: toOpenAiTools(input.tools) } : {}),
      },
    })
    logger.info(
      {
        requestId: input.requestId,
        workspace_id: input.workspace.workspace_id,
        provider: input.provider,
        model: input.model,
        response_status: response.status,
        advertised_tool_count: input.tools.length,
      },
      'managed llm gateway response streaming',
    )
    yield* parseOpenAiSse(response, { requestId: input.requestId })
  },
}

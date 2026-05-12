import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WorkspaceToken } from '../lib/jwt.js'
import { logger } from '../middleware/logger.js'
import { getCloudChatRepo, type CloudChatMessage } from '../orchestrator/cloudChatRepo.js'
import {
  buildCloudAssistantEvent,
  publishCloudChatEvent,
  subscribeCloudChatEvents,
} from '../orchestrator/cloudChatEventHub.js'
import { getDesktopAssistantsRepo } from '../orchestrator/desktopAssistantsRepo.js'
import { managedLlmGatewayProvider } from '../orchestrator/managedLlmGatewayProvider.js'
import {
  completeManagedHostRequest,
  registerManagedHostClient,
  unregisterManagedHostClient,
} from '../orchestrator/managedHostBridge.js'
import {
  clearComposioToolkitPreferences,
  getComposioSkillPreferences,
  patchComposioToolkitPreferences,
} from '../lib/composio-skill-preferences.js'
import { ComposioClient, getComposioApiKey } from '../lib/composio.js'
import {
  runManagedAssistant,
  setDefaultManagedAssistantProvider,
  type ManagedAssistantMessage,
  type ManagedAssistantToolCall,
  type ManagedAssistantToolResult,
} from '../orchestrator/managedAssistantRunner.js'
import { managedComposioSkillsForWorkspace } from './composio.js'

const MAX_CONTEXT_MESSAGES = 40
const MAX_HISTORY_LIMIT = 200
const MAX_TITLE_LENGTH = 80
const FIRST_PARTY_SKILLS = [
  {
    id: 'macos-automation',
    name: 'macos-automation',
    description: 'Automate native macOS apps and system interactions.',
    emoji: '🍎',
    kind: 'bundled',
    origin: 'basics',
    status: 'enabled',
  },
  {
    id: 'mcp-setup',
    name: 'mcp-setup',
    description: 'Add, authenticate, list, and remove MCP servers.',
    emoji: '🔌',
    kind: 'catalog',
    origin: 'basics',
    status: 'available',
  },
  {
    id: 'google-calendar',
    name: 'google-calendar',
    description: 'View, create, and manage Google Calendar events.',
    emoji: '📅',
    kind: 'catalog',
    origin: 'basics',
    status: 'available',
  },
]

async function assistantSkillsForWorkspace(input: {
  workspace: WorkspaceToken
  requestId: string
  assistantId: string
}) {
  try {
    return [
      ...FIRST_PARTY_SKILLS,
      ...(await managedComposioSkillsForWorkspace(input.workspace, input.assistantId)),
    ]
  } catch (err) {
    logger.warn(
      {
        requestId: input.requestId,
        workspace_id: input.workspace.workspace_id,
        assistant_id: input.assistantId,
        err,
      },
      'assistant scoped Composio skills lookup failed',
    )
    return FIRST_PARTY_SKILLS
  }
}

const skillConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    disabledToolSlugs: z.array(z.string().min(1)).optional(),
    selectedConnectedAccountId: z.string().min(1).nullable().optional(),
    display: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

setDefaultManagedAssistantProvider(managedLlmGatewayProvider)

type Vars = { requestId: string; workspace: WorkspaceToken }

export const cloudChatRoute = new Hono<{ Variables: Vars }>()

const sendMessageBodySchema = z
  .object({
    conversationKey: z.string().min(1).max(512).optional(),
    content: z.string().optional(),
    attachmentIds: z.array(z.string()).optional(),
    sourceChannel: z.string().optional(),
    interface: z.string().optional(),
    conversationType: z.string().optional(),
    automated: z.boolean().optional(),
    bypassSecretCheck: z.boolean().optional(),
    hostHomeDir: z.string().optional(),
    hostUsername: z.string().optional(),
    clientTimezone: z.unknown().optional(),
    clientId: z.string().optional(),
    clientMessageId: z.string().min(1).max(512).optional(),
    inferenceProfile: z.string().nullable().optional(),
    riskThreshold: z.string().optional(),
    onboarding: z.unknown().optional(),
  })
  .passthrough()

const renameBodySchema = z.object({ name: z.string().min(1).max(256) }).strict()

const reorderBodySchema = z
  .object({
    updates: z.array(z.unknown()).optional(),
  })
  .passthrough()

const seenBodySchema = z
  .object({
    conversationId: z.string().optional(),
    conversationIds: z.array(z.string()).optional(),
  })
  .passthrough()

const hostResultBodySchema = z
  .object({
    requestId: z.string().min(1),
    result: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough()

function invalidRequest(
  result: { success: false; error: Parameters<typeof z.flattenError>[0] },
  c: { json: (body: unknown, status: 400) => Response },
) {
  return c.json(
    {
      error: 'invalid_request',
      code: 'validation_failed',
      issues: z.flattenError(result.error),
    },
    400,
  )
}

function titleFromContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (!collapsed) return 'New conversation'
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function clientToolName(name: string): string {
  if (name === 'host_bash') return 'bash'
  if (name === 'host_file_read') return 'file_read'
  return name
}

function toolUseStartFrame(input: { conversationId: string; toolCall: ManagedAssistantToolCall }) {
  return {
    type: 'tool_use_start',
    toolName: clientToolName(input.toolCall.name),
    input: input.toolCall.arguments,
    conversationId: input.conversationId,
    toolUseId: input.toolCall.id,
  }
}

function toolResultFrame(input: { conversationId: string; result: ManagedAssistantToolResult }) {
  return {
    type: 'tool_result',
    toolName: clientToolName(input.result.name),
    result: input.result.content,
    isError: false,
    conversationId: input.conversationId,
    toolUseId: input.result.toolCallId,
  }
}

function timestampMs(iso: string | null): number | null {
  if (!iso) return null
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : null
}

async function requireAssistant(workspaceId: string, assistantId: string) {
  return getDesktopAssistantsRepo().get(workspaceId, assistantId)
}

async function handleAssistantHealth(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId') ?? ''
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json(
    {
      ok: true,
      version: 'runtime',
      assistantId,
      ts: new Date().toISOString(),
    },
    200,
  )
}

function toManagedMessages(messages: CloudChatMessage[]): ManagedAssistantMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}

function parseBeforeTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function serializeConversation(input: {
  id: string
  title: string
  source: string
  createdAt: string
  updatedAt: string
  lastMessageAt: string | null
  archived?: boolean
}) {
  return {
    id: input.id,
    title: input.title,
    createdAt: timestampMs(input.createdAt),
    updatedAt: timestampMs(input.updatedAt) ?? Date.now(),
    lastMessageAt: timestampMs(input.lastMessageAt),
    conversationType: 'standard',
    source: input.source,
    conversationOriginChannel: 'vellum',
    conversationOriginInterface: 'macos',
    archived: input.archived ?? false,
  }
}

function serializeHistoryMessage(message: CloudChatMessage) {
  return {
    id: message.id,
    daemonMessageId: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
  }
}

async function writeFrame(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  frame: Record<string, unknown> & { type: string },
) {
  const event = buildCloudAssistantEvent(frame)
  await stream.writeSSE({
    event: 'assistant_event',
    id: event.id,
    data: JSON.stringify(event),
  })
}

async function writeHeartbeat(stream: Parameters<Parameters<typeof streamSSE>[1]>[0]) {
  await stream.write(': heartbeat\n\n')
}

async function runCloudChatGeneration(input: {
  workspace: WorkspaceToken
  requestId: string
  assistantId: string
  conversationId: string
  accountId: string
  trimmed: string
  userMessageId: string
  clientMessageId: string | undefined
}) {
  const repo = getCloudChatRepo()
  let assistantText = ''
  let tokensInput = 0
  let tokensOutput = 0
  let model = 'managed'
  const startedAt = Date.now()
  const eventTarget = {
    workspaceId: input.workspace.workspace_id,
    assistantId: input.assistantId,
  }

  await publishCloudChatEvent(eventTarget, {
    type: 'user_message_echo',
    text: input.trimmed,
    conversationId: input.conversationId,
    messageId: input.userMessageId,
    clientMessageId: input.clientMessageId,
  })

  try {
    const history = await repo.listMessages({
      workspaceId: input.workspace.workspace_id,
      conversationId: input.conversationId,
      limit: MAX_CONTEXT_MESSAGES,
    })
    logger.info(
      {
        requestId: input.requestId,
        workspace_id: input.workspace.workspace_id,
        assistant_id: input.assistantId,
        conversation_id: input.conversationId,
        history_message_count: history.messages.length,
      },
      'cloud chat generation history loaded',
    )
    const iter = runManagedAssistant({
      workspace: input.workspace,
      assistantId: input.assistantId,
      requestId: input.requestId,
      conversationId: input.conversationId,
      messages: toManagedMessages(history.messages),
    })

    for await (const event of iter) {
      if (event.type === 'tool_call') {
        logger.info(
          {
            requestId: input.requestId,
            workspace_id: input.workspace.workspace_id,
            assistant_id: input.assistantId,
            conversation_id: input.conversationId,
            tool_call_id: event.toolCall.id,
            tool_name: event.toolCall.name,
            argument_keys: Object.keys(event.toolCall.arguments),
          },
          'cloud chat publishing tool use start',
        )
        await publishCloudChatEvent(
          eventTarget,
          toolUseStartFrame({
            conversationId: input.conversationId,
            toolCall: event.toolCall,
          }),
        )
      }
      if (event.type === 'tool_result') {
        logger.info(
          {
            requestId: input.requestId,
            workspace_id: input.workspace.workspace_id,
            assistant_id: input.assistantId,
            conversation_id: input.conversationId,
            tool_call_id: event.result.toolCallId,
            tool_name: event.result.name,
            result_chars: event.result.content.length,
          },
          'cloud chat publishing tool result',
        )
        await publishCloudChatEvent(
          eventTarget,
          toolResultFrame({
            conversationId: input.conversationId,
            result: event.result,
          }),
        )
      }
      if (event.type === 'text_delta') {
        assistantText += event.text
        await publishCloudChatEvent(eventTarget, {
          type: 'assistant_text_delta',
          text: event.text,
          conversationId: input.conversationId,
        })
      }
      if (event.type === 'usage') {
        model = event.model ?? model
        tokensInput = event.tokensInput ?? tokensInput
        tokensOutput = event.tokensOutput ?? tokensOutput
      }
      if (event.type === 'done') {
        model = event.model
        tokensInput = event.tokensInput
        tokensOutput = event.tokensOutput
      }
    }

    const assistantMessage = await repo.addMessage({
      conversationId: input.conversationId,
      workspaceId: input.workspace.workspace_id,
      accountId: input.accountId,
      role: 'assistant',
      content: assistantText,
      metadata: {
        status: 'complete',
        model,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
      },
    })
    await publishCloudChatEvent(eventTarget, {
      type: 'message_complete',
      conversationId: input.conversationId,
      messageId: assistantMessage.id,
    })
    logger.info(
      {
        requestId: input.requestId,
        workspace_id: input.workspace.workspace_id,
        assistant_id: input.assistantId,
        conversation_id: input.conversationId,
        latency_ms: Date.now() - startedAt,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        assistant_text_chars: assistantText.length,
      },
      'cloud chat request done',
    )
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    await repo.addMessage({
      conversationId: input.conversationId,
      workspaceId: input.workspace.workspace_id,
      accountId: input.accountId,
      role: 'assistant',
      content: assistantText,
      metadata: {
        status: assistantText ? 'partial_error' : 'error',
        error: error.message,
        model,
      },
    })
    logger.error(
      {
        requestId: input.requestId,
        err: { name: error.name, message: error.message },
        workspace_id: input.workspace.workspace_id,
        assistant_id: input.assistantId,
        conversation_id: input.conversationId,
      },
      'cloud chat stream failed',
    )
    await publishCloudChatEvent(eventTarget, {
      type: 'conversation_error',
      conversationId: input.conversationId,
      code: 'UNKNOWN',
      userMessage: 'The cloud assistant failed while generating a response.',
      retryable: true,
      debugDetails: error.message,
      errorCategory: 'cloud_chat',
    })
  }
}

cloudChatRoute.post(
  '/:assistantId/messages/',
  zValidator('json', sendMessageBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const requestId = c.get('requestId')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)

    const body = c.req.valid('json')
    const content = typeof body.content === 'string' ? body.content : ''
    const trimmed = content.trim()
    if (trimmed.length === 0) {
      return c.json({ error: 'invalid_request', message: 'content is required' }, 400)
    }

    const repo = getCloudChatRepo()
    const clientConversationKey =
      body.conversationKey ??
      `default:${body.sourceChannel ?? 'vellum'}:${body.interface ?? 'macos'}`
    const source = body.sourceChannel ?? 'vellum'

    const existingByServerId = isUuid(clientConversationKey)
      ? await repo.getConversation({
          workspaceId: workspace.workspace_id,
          assistantId,
          conversationId: clientConversationKey,
        })
      : null
    const conversation =
      existingByServerId ??
      (await repo.getOrCreateConversation({
        workspaceId: workspace.workspace_id,
        accountId: workspace.account_id,
        assistantId,
        clientConversationKey,
        title: titleFromContent(trimmed),
        source,
      }))
    const userMessage = await repo.addMessage({
      conversationId: conversation.id,
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      role: 'user',
      content: trimmed,
      metadata: {
        source_channel: body.sourceChannel ?? null,
        interface: body.interface ?? null,
        client_timezone: body.clientTimezone ?? null,
        automated: body.automated === true,
      },
      clientMessageId: body.clientMessageId ?? null,
    })

    logger.info(
      {
        requestId,
        workspace_id: workspace.workspace_id,
        assistant_id: assistantId,
        conversation_id: conversation.id,
        client_conversation_key_kind: isUuid(clientConversationKey) ? 'server_id' : 'client_key',
        content_chars: trimmed.length,
        source_channel: body.sourceChannel ?? null,
        interface: body.interface ?? null,
        client_message_id_present: Boolean(body.clientMessageId),
      },
      'cloud chat request start',
    )

    void runCloudChatGeneration({
      workspace,
      requestId,
      assistantId,
      conversationId: conversation.id,
      accountId: workspace.account_id,
      trimmed,
      userMessageId: userMessage.id,
      clientMessageId: body.clientMessageId,
    })

    return c.json(
      { accepted: true, messageId: userMessage.id, conversationId: conversation.id },
      202,
    )
  },
)

cloudChatRoute.get('/:assistantId/health', handleAssistantHealth)
cloudChatRoute.get('/:assistantId/health/', handleAssistantHealth)

async function handleEvents(c: Context<{ Variables: Vars }>) {
  const workspace = c.get('workspace')
  const requestId = c.get('requestId')
  const assistantId = c.req.param('assistantId') ?? ''
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)

  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache, no-transform')

  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribeCloudChatEvents({
      workspaceId: workspace.workspace_id,
      assistantId,
      send: async (frame) => {
        await writeFrame(stream, frame)
      },
    })
    const registered = registerManagedHostClient({
      workspaceId: workspace.workspace_id,
      assistantId,
      clientId: c.req.header('X-Basics-Client-Id') ?? c.req.header('X-Vellum-Client-Id') ?? null,
      interfaceId:
        c.req.header('X-Basics-Interface-Id') ?? c.req.header('X-Vellum-Interface-Id') ?? null,
      machineName:
        c.req.header('X-Basics-Machine-Name') ?? c.req.header('X-Vellum-Machine-Name') ?? null,
      send: async (frame) => {
        await writeFrame(stream, frame)
      },
    })
    logger.info(
      {
        requestId,
        workspace_id: workspace.workspace_id,
        assistant_id: assistantId,
        client_id: registered.clientId,
        interface_id: registered.interfaceId,
        capabilities: registered.capabilities,
      },
      'cloud chat events stream connected',
    )
    try {
      await writeHeartbeat(stream)
      while (!stream.aborted) {
        await stream.sleep(25_000)
        await writeHeartbeat(stream)
      }
    } finally {
      logger.info(
        {
          requestId,
          workspace_id: workspace.workspace_id,
          assistant_id: assistantId,
          client_id: registered.clientId,
        },
        'cloud chat events stream disconnected',
      )
      unsubscribe()
      unregisterManagedHostClient({
        workspaceId: workspace.workspace_id,
        assistantId,
        clientId: registered.clientId,
      })
    }
  })
}

cloudChatRoute.get('/:assistantId/events', async (c) => handleEvents(c))
cloudChatRoute.get('/:assistantId/events/', async (c) => handleEvents(c))

function completeHostResult(
  body: z.infer<typeof hostResultBodySchema>,
  input: { clientId: string | null },
) {
  return completeManagedHostRequest(
    body.requestId,
    body.result ?? body.output ?? body.error ?? body,
    input,
  )
}

async function handleHostResult(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: {
    param: (key: 'assistantId') => string
    header: (name: string) => string | undefined
    valid: (target: 'json') => z.infer<typeof hostResultBodySchema>
  }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId') ?? ''
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const completed = completeHostResult(c.req.valid('json'), {
    clientId: c.req.header('X-Basics-Client-Id') ?? c.req.header('X-Vellum-Client-Id') ?? null,
  })
  return c.json({ accepted: completed, ok: completed }, completed ? 200 : 404)
}

cloudChatRoute.post(
  '/:assistantId/host-bash-result',
  zValidator('json', hostResultBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => handleHostResult(c),
)
cloudChatRoute.post(
  '/:assistantId/host-bash-result/',
  zValidator('json', hostResultBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => handleHostResult(c),
)
cloudChatRoute.post(
  '/:assistantId/host-file-result',
  zValidator('json', hostResultBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => handleHostResult(c),
)
cloudChatRoute.post(
  '/:assistantId/host-file-result/',
  zValidator('json', hostResultBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => handleHostResult(c),
)

cloudChatRoute.get('/:assistantId/skills', async (c) => {
  const workspace = c.get('workspace')
  const requestId = c.get('requestId')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const skills = await assistantSkillsForWorkspace({ workspace, requestId, assistantId })
  return c.json({ skills, origin: 'basics' }, 200)
})
cloudChatRoute.get('/:assistantId/skills/', async (c) => {
  const workspace = c.get('workspace')
  const requestId = c.get('requestId')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const skills = await assistantSkillsForWorkspace({ workspace, requestId, assistantId })
  return c.json({ skills, origin: 'basics' }, 200)
})

async function loadComposioSkillConfig(input: {
  workspace: WorkspaceToken
  assistantId: string
  skillId: string
}) {
  if (!getComposioApiKey()) return { status: 503 as const, body: { error: 'capability_unavailable', capability: 'composio' } }
  if (!input.skillId.startsWith('composio-')) return { status: 404 as const, body: { error: 'not_found' } }
  const toolkitSlug = input.skillId.slice('composio-'.length)
  if (!toolkitSlug) return { status: 404 as const, body: { error: 'not_found' } }
  const preferences = await getComposioSkillPreferences({
    workspaceId: input.workspace.workspace_id,
    accountId: input.workspace.account_id,
    assistantId: input.assistantId,
  })
  const skills = (await managedComposioSkillsForWorkspace(input.workspace, input.assistantId, {
    includeTools: true,
  })) as Array<{
    id: string
    toolkitSlug?: string
    connectedAccountId?: string
    authConfigId?: string
    status?: string
    tools?: unknown[]
  }>
  const skill = skills.find((candidate) => candidate.id === input.skillId)
  if (!skill || skill.toolkitSlug !== toolkitSlug) {
    return { status: 404 as const, body: { error: 'not_found' } }
  }
  return {
    status: 200 as const,
    body: {
      skillId: input.skillId,
      toolkitSlug,
      enabled: !preferences.disabledToolkitSlugs.includes(toolkitSlug),
      disabledToolSlugs: preferences.disabledToolSlugs.filter((slug) =>
        slug.startsWith(`${toolkitSlug}_`),
      ),
      selectedConnectedAccountId: preferences.connectedAccountIdsByToolkit[toolkitSlug] ?? null,
      connectedAccountId: skill.connectedAccountId ?? null,
      authConfigId: skill.authConfigId ?? null,
      status: skill.status,
      tools: skill.tools ?? [],
      display: preferences.display ?? {},
    },
  }
}

cloudChatRoute.get('/:assistantId/skills/:skillId/config', async (c) => {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const result = await loadComposioSkillConfig({
    workspace,
    assistantId,
    skillId: c.req.param('skillId'),
  })
  return c.json(result.body, result.status)
})
cloudChatRoute.get('/:assistantId/skills/:skillId/config/', async (c) => {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const result = await loadComposioSkillConfig({
    workspace,
    assistantId,
    skillId: c.req.param('skillId'),
  })
  return c.json(result.body, result.status)
})

cloudChatRoute.patch(
  '/:assistantId/skills/:skillId/config',
  zValidator('json', skillConfigPatchSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    const skillId = c.req.param('skillId')
    if (!skillId.startsWith('composio-')) {
      return c.json({ error: 'skill_not_configurable' }, 409)
    }
    const toolkitSlug = skillId.slice('composio-'.length)
    const before = await loadComposioSkillConfig({ workspace, assistantId, skillId })
    if (before.status !== 200) return c.json(before.body, before.status)
    const preferences = await patchComposioToolkitPreferences(
      {
        workspaceId: workspace.workspace_id,
        accountId: workspace.account_id,
        assistantId,
      },
      toolkitSlug,
      c.req.valid('json'),
    )
    return c.json({ ok: true, preferences }, 200)
  },
)
cloudChatRoute.patch(
  '/:assistantId/skills/:skillId/config/',
  zValidator('json', skillConfigPatchSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    const skillId = c.req.param('skillId')
    if (!skillId.startsWith('composio-')) {
      return c.json({ error: 'skill_not_configurable' }, 409)
    }
    const toolkitSlug = skillId.slice('composio-'.length)
    const before = await loadComposioSkillConfig({ workspace, assistantId, skillId })
    if (before.status !== 200) return c.json(before.body, before.status)
    const preferences = await patchComposioToolkitPreferences(
      {
        workspaceId: workspace.workspace_id,
        accountId: workspace.account_id,
        assistantId,
      },
      toolkitSlug,
      c.req.valid('json'),
    )
    return c.json({ ok: true, preferences }, 200)
  },
)

async function handleDeleteAssistantSkill(c: Context<{ Variables: Vars }>) {
  const workspace = c.get('workspace')
  const assistantId = String(c.req.param('assistantId') ?? '')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const skillId = c.req.param('skillId') ?? ''
  if (!skillId.startsWith('composio-')) {
    const bundled = FIRST_PARTY_SKILLS.find((skill) => skill.id === skillId)
    if (bundled) return c.json({ error: 'skill_not_removable', detail: 'Bundled skills can be disabled, not removed.' }, 409)
    return c.json({ error: 'not_found' }, 404)
  }
  if (!getComposioApiKey()) {
    return c.json({ error: 'capability_unavailable', capability: 'composio' }, 503)
  }
  const toolkitSlug = skillId.slice('composio-'.length)
  const connectedAccountId = c.req.query('connectedAccountId')?.trim()
  if (!connectedAccountId) {
    return c.json({ error: 'invalid_request', detail: 'connectedAccountId is required' }, 400)
  }
  const client = new ComposioClient()
  const [accounts, authConfigs] = await Promise.all([
    client.listConnectedAccounts(workspace.account_id || workspace.workspace_id),
    client.listAuthConfigs(),
  ])
  const authConfigToolkitById = new Map(
    authConfigs.map((authConfig) => [authConfig.id, authConfig.toolkit?.slug]),
  )
  const account = accounts.find(
    (candidate) =>
      candidate.id === connectedAccountId &&
      (candidate.toolkit?.slug === toolkitSlug ||
        authConfigToolkitById.get(candidate.auth_config?.id ?? '') === toolkitSlug),
  )
  if (!account) return c.json({ error: 'not_found' }, 404)
  await client.deleteConnectedAccount(connectedAccountId)
  await clearComposioToolkitPreferences(
    {
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      assistantId,
    },
    toolkitSlug,
    connectedAccountId,
  )
  return c.json({ ok: true, disconnected: true }, 200)
}

cloudChatRoute.delete('/:assistantId/skills/:skillId', handleDeleteAssistantSkill)
cloudChatRoute.delete('/:assistantId/skills/:skillId/', handleDeleteAssistantSkill)

cloudChatRoute.get('/:assistantId/channels/readiness', async (c) => {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json({ channels: [], ready: false, status: 'unavailable' }, 200)
})
cloudChatRoute.get('/:assistantId/channels/readiness/', async (c) => {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json({ channels: [], ready: false, status: 'unavailable' }, 200)
})

cloudChatRoute.get('/:assistantId/integrations/status', async (c) => {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json({ integrations: [], status: 'unconfigured' }, 200)
})
cloudChatRoute.get('/:assistantId/integrations/status/', async (c) => {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json({ integrations: [], status: 'unconfigured' }, 200)
})

async function handleListConversations(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: {
    param: (key: 'assistantId') => string
    query: (key: string) => string | undefined
  }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0') || 0)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '50') || 50))
  const result = await getCloudChatRepo().listConversations({
    workspaceId: workspace.workspace_id,
    assistantId,
    offset,
    limit,
  })
  return c.json(
    {
      conversations: result.conversations.map(serializeConversation),
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
      groups: [],
    },
    200,
  )
}

cloudChatRoute.get('/:assistantId/conversations', handleListConversations)
cloudChatRoute.get('/:assistantId/conversations/', handleListConversations)

async function handleGetConversation(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId' | 'conversationId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const conversation = await getCloudChatRepo().getConversation({
    workspaceId: workspace.workspace_id,
    assistantId,
    conversationId: c.req.param('conversationId'),
  })
  if (!conversation) return c.json({ detail: 'Conversation not found' }, 404)
  return c.json({ conversation: serializeConversation(conversation) }, 200)
}

cloudChatRoute.get('/:assistantId/conversations/:conversationId', handleGetConversation)
cloudChatRoute.get('/:assistantId/conversations/:conversationId/', handleGetConversation)

async function handleDeleteAllConversations(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const deletedCount = await getCloudChatRepo().deleteAllConversations({
    workspaceId: workspace.workspace_id,
    assistantId,
  })
  return c.json({ success: true, deletedCount }, 200)
}

cloudChatRoute.delete('/:assistantId/conversations', handleDeleteAllConversations)
cloudChatRoute.delete('/:assistantId/conversations/', handleDeleteAllConversations)

async function handleDeleteConversation(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId' | 'conversationId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const deleted = await getCloudChatRepo().deleteConversation({
    workspaceId: workspace.workspace_id,
    assistantId,
    conversationId: c.req.param('conversationId'),
  })
  if (!deleted) return c.json({ detail: 'Conversation not found' }, 404)
  return c.json({ success: true, deleted: true }, 200)
}

cloudChatRoute.delete('/:assistantId/conversations/:conversationId', handleDeleteConversation)
cloudChatRoute.delete('/:assistantId/conversations/:conversationId/', handleDeleteConversation)

async function handleSetConversationArchived(
  c: {
    get: (key: 'workspace') => WorkspaceToken
    req: { param: (key: 'assistantId' | 'conversationId') => string }
    json: (body: unknown, status?: number) => Response
  },
  archived: boolean,
) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const conversation = await getCloudChatRepo().setConversationArchived({
    workspaceId: workspace.workspace_id,
    assistantId,
    conversationId: c.req.param('conversationId'),
    archived,
  })
  if (!conversation) return c.json({ detail: 'Conversation not found' }, 404)
  return c.json(serializeConversation(conversation), 200)
}

cloudChatRoute.post('/:assistantId/conversations/:conversationId/archive', async (c) =>
  handleSetConversationArchived(c, true),
)
cloudChatRoute.post('/:assistantId/conversations/:conversationId/archive/', async (c) =>
  handleSetConversationArchived(c, true),
)
cloudChatRoute.post('/:assistantId/conversations/:conversationId/unarchive', async (c) =>
  handleSetConversationArchived(c, false),
)
cloudChatRoute.post('/:assistantId/conversations/:conversationId/unarchive/', async (c) =>
  handleSetConversationArchived(c, false),
)

async function handleUndoConversation(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId' | 'conversationId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const conversationId = c.req.param('conversationId')
  const result = await getCloudChatRepo().undoLastExchange({
    workspaceId: workspace.workspace_id,
    assistantId,
    conversationId,
  })
  if (!result) return c.json({ detail: 'Conversation not found' }, 404)
  await publishCloudChatEvent(
    { workspaceId: workspace.workspace_id, assistantId },
    {
      type: 'undo_complete',
      conversationId,
      removedCount: result.removedCount,
    },
  )
  return c.json({ conversationId, removedCount: result.removedCount }, 200)
}

cloudChatRoute.post('/:assistantId/conversations/:conversationId/undo', handleUndoConversation)
cloudChatRoute.post('/:assistantId/conversations/:conversationId/undo/', handleUndoConversation)

async function handleGetMessages(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: {
    param: (key: 'assistantId') => string
    query: (key: string) => string | undefined
  }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const conversationId = c.req.query('conversationId')
  if (!conversationId) {
    return c.json({ error: 'invalid_request', message: 'conversationId is required' }, 400)
  }
  const conversation = await getCloudChatRepo().getConversation({
    workspaceId: workspace.workspace_id,
    assistantId,
    conversationId,
  })
  if (!conversation) return c.json({ detail: 'Conversation not found' }, 404)
  const limit = Math.min(
    MAX_HISTORY_LIMIT,
    Math.max(1, Number(c.req.query('limit') ?? '100') || 100),
  )
  const result = await getCloudChatRepo().listMessages({
    workspaceId: workspace.workspace_id,
    conversationId,
    limit,
    before: parseBeforeTimestamp(c.req.query('beforeTimestamp')),
  })
  return c.json(
    {
      conversationId,
      messages: result.messages.map(serializeHistoryMessage),
      hasMore: result.hasMore,
      oldestTimestamp:
        result.messages.length > 0 ? timestampMs(result.messages[0]!.createdAt) : null,
    },
    200,
  )
}

cloudChatRoute.get('/:assistantId/messages', handleGetMessages)
cloudChatRoute.get('/:assistantId/messages/', handleGetMessages)

cloudChatRoute.post(
  '/:assistantId/conversations/reorder',
  zValidator('json', reorderBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    return c.json({ ok: true }, 200)
  },
)

cloudChatRoute.post(
  '/:assistantId/conversations/reorder/',
  zValidator('json', reorderBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    return c.json({ ok: true }, 200)
  },
)

cloudChatRoute.post(
  '/:assistantId/conversations/seen',
  zValidator('json', seenBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    return c.json({ ok: true }, 200)
  },
)

cloudChatRoute.post(
  '/:assistantId/conversations/seen/',
  zValidator('json', seenBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    return c.json({ ok: true }, 200)
  },
)

async function handleRenameConversation(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: {
    param: (key: 'assistantId' | 'conversationId') => string
    valid: (target: 'json') => z.infer<typeof renameBodySchema>
  }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const renamed = await getCloudChatRepo().renameConversation({
    workspaceId: workspace.workspace_id,
    assistantId,
    conversationId: c.req.param('conversationId'),
    title: c.req.valid('json').name,
  })
  if (!renamed) return c.json({ detail: 'Conversation not found' }, 404)
  return c.json(serializeConversation(renamed), 200)
}

cloudChatRoute.patch(
  '/:assistantId/conversations/:conversationId/name',
  zValidator('json', renameBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => handleRenameConversation(c),
)

cloudChatRoute.patch(
  '/:assistantId/conversations/:conversationId/name/',
  zValidator('json', renameBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => handleRenameConversation(c),
)

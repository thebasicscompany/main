import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getGeminiClientForWorkspace } from '../lib/gemini.js'
import { recordLlmProxyUsage } from '../lib/metering.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { logger } from '../middleware/logger.js'
import {
  getCloudChatRepo,
  type CloudChatMessage,
} from '../orchestrator/cloudChatRepo.js'
import { getDesktopAssistantsRepo } from '../orchestrator/desktopAssistantsRepo.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_MAX_TOKENS = 4096
const MAX_CONTEXT_MESSAGES = 40
const MAX_HISTORY_LIMIT = 200
const MAX_TITLE_LENGTH = 80

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

const renameBodySchema = z
  .object({ name: z.string().min(1).max(256) })
  .strict()

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
  const assistantId = c.req.param('assistantId')
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

function toGeminiInput(messages: CloudChatMessage[]) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
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
  await stream.writeSSE({
    event: frame.type,
    data: JSON.stringify(frame),
  })
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
      return c.json(
        { error: 'invalid_request', message: 'content is required' },
        400,
      )
    }

    const repo = getCloudChatRepo()
    const clientConversationKey =
      body.conversationKey ?? `default:${body.sourceChannel ?? 'vellum'}:${body.interface ?? 'macos'}`
    const source = body.sourceChannel ?? 'vellum'

    const conversation = await repo.getOrCreateConversation({
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      assistantId,
      clientConversationKey,
      title: titleFromContent(trimmed),
      source,
    })
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
      },
      'cloud chat request start',
    )

    c.header('X-Accel-Buffering', 'no')
    c.header('Cache-Control', 'no-cache, no-transform')

    return streamSSE(c, async (stream) => {
      let assistantText = ''
      let tokensInput = 0
      let tokensOutput = 0
      const startedAt = Date.now()

      await writeFrame(stream, {
        type: 'user_message_echo',
        text: trimmed,
        conversationId: conversation.id,
        messageId: userMessage.id,
        clientMessageId: body.clientMessageId,
      })

      try {
        const history = await repo.listMessages({
          workspaceId: workspace.workspace_id,
          conversationId: conversation.id,
          limit: MAX_CONTEXT_MESSAGES,
        })
        const geminiHandle = await getGeminiClientForWorkspace(workspace.workspace_id)
        const iter = await geminiHandle.genai.models.generateContentStream({
          model: DEFAULT_MODEL,
          contents: toGeminiInput(history.messages) as never,
          config: { maxOutputTokens: DEFAULT_MAX_TOKENS } as never,
        })

        for await (const chunk of iter) {
          const text = chunk.text
          if (text) {
            assistantText += text
            await writeFrame(stream, {
              type: 'assistant_text_delta',
              text,
              conversationId: conversation.id,
            })
          }
          const usage = (
            chunk as {
              usageMetadata?: {
                promptTokenCount?: number
                candidatesTokenCount?: number
              }
            }
          ).usageMetadata
          if (usage) {
            if (typeof usage.promptTokenCount === 'number') {
              tokensInput = usage.promptTokenCount
            }
            if (typeof usage.candidatesTokenCount === 'number') {
              tokensOutput = usage.candidatesTokenCount
            }
          }
        }

        const assistantMessage = await repo.addMessage({
          conversationId: conversation.id,
          workspaceId: workspace.workspace_id,
          accountId: workspace.account_id,
          role: 'assistant',
          content: assistantText,
          metadata: {
            status: 'complete',
            model: DEFAULT_MODEL,
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
            credential_id: geminiHandle.credentialId,
            credential_provenance: geminiHandle.provenance,
          },
        })
        await recordLlmProxyUsage({
          workspaceId: workspace.workspace_id,
          accountId: workspace.account_id,
          model: DEFAULT_MODEL,
          tokensInput,
          tokensOutput,
          requestId,
          credentialMetadata: {
            credential_id: geminiHandle.credentialId,
            provenance: geminiHandle.provenance,
            conversation_id: conversation.id,
          },
        })
        await writeFrame(stream, {
          type: 'message_complete',
          conversationId: conversation.id,
          messageId: assistantMessage.id,
        })
        logger.info(
          {
            requestId,
            workspace_id: workspace.workspace_id,
            assistant_id: assistantId,
            conversation_id: conversation.id,
            latency_ms: Date.now() - startedAt,
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
          },
          'cloud chat request done',
        )
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        await repo.addMessage({
          conversationId: conversation.id,
          workspaceId: workspace.workspace_id,
          accountId: workspace.account_id,
          role: 'assistant',
          content: assistantText,
          metadata: {
            status: assistantText ? 'partial_error' : 'error',
            error: error.message,
            model: DEFAULT_MODEL,
          },
        })
        logger.error(
          {
            requestId,
            err: { name: error.name, message: error.message },
            workspace_id: workspace.workspace_id,
            assistant_id: assistantId,
            conversation_id: conversation.id,
          },
          'cloud chat stream failed',
        )
        await writeFrame(stream, {
          type: 'conversation_error',
          conversationId: conversation.id,
          code: 'UNKNOWN',
          userMessage: 'The cloud assistant failed while generating a response.',
          retryable: true,
          debugDetails: error.message,
          errorCategory: 'cloud_chat',
        })
      }
    })
  },
)

cloudChatRoute.get('/:assistantId/health', handleAssistantHealth)
cloudChatRoute.get('/:assistantId/health/', handleAssistantHealth)

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
  const limit = Math.min(
    100,
    Math.max(1, Number(c.req.query('limit') ?? '50') || 50),
  )
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
    return c.json(
      { error: 'invalid_request', message: 'conversationId is required' },
      400,
    )
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
        result.messages.length > 0
          ? timestampMs(result.messages[0]!.createdAt)
          : null,
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

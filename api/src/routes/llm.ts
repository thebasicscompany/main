import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getGeminiClientForWorkspace } from '../lib/gemini.js'
import { recordLlmProxyUsage } from '../lib/metering.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_MAX_TOKENS = 4096
const MAX_OUTPUT_TOKENS = 16384
const MAX_MESSAGES = 100

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
})

const llmBodySchema = z
  .object({
    messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
    model: z.string().min(1).optional(),
    max_tokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
  })
  .strict()

type Vars = { requestId: string; workspace: WorkspaceToken }

export const llmRoute = new Hono<{ Variables: Vars }>()

/**
 * Split mixed `system|user|assistant` messages into Gemini's
 * (systemInstruction, contents) shape. Multiple system messages are
 * concatenated; user/assistant turns become `contents` in order.
 */
function toGeminiInput(messages: z.infer<typeof messageSchema>[]) {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }
    turns.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents: turns,
  }
}

/**
 * POST /v1/llm
 *
 * Minimal SSE-streaming LLM proxy backed by Gemini Flash. Accepts
 * `{ messages, model?, max_tokens? }` and emits:
 *   - `event: token`  `data: {"text":"..."}`           (per chunk)
 *   - `event: done`   `data: {"model":"...", "tokens_input":N, "tokens_output":N}`
 *   - `event: error`  `data: {"code":"...", "message":"..."}`  (on failure)
 *
 * No tool loop, no DB persistence — that comes back later when the
 * runtime has its own conversation tables. Returns 503 if
 * `GEMINI_API_KEY` is unset (caught at first getConfig() access).
 */
llmRoute.post(
  '/',
  zValidator('json', llmBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'invalid_request',
          code: 'validation_failed',
          issues: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  async (c) => {
    const body = c.req.valid('json')
    const requestId = c.get('requestId')
    const workspace = c.get('workspace')

    // Capability gate. requireWorkspaceJwt already 401'd unauth callers,
    // so by the time we reach here we have a valid workspace token.
    const model = body.model ?? DEFAULT_MODEL
    const maxTokens = body.max_tokens ?? DEFAULT_MAX_TOKENS
    const { system, contents } = toGeminiInput(body.messages)

    const genConfig: Record<string, unknown> = { maxOutputTokens: maxTokens }
    if (system !== undefined) {
      genConfig.systemInstruction = { parts: [{ text: system }] }
    }

    logger.info(
      {
        requestId,
        workspace_id: workspace.workspace_id,
        account_id: workspace.account_id,
        model,
        messageCount: body.messages.length,
      },
      'llm request start',
    )

    c.header('X-Accel-Buffering', 'no')
    c.header('Cache-Control', 'no-cache, no-transform')

    return streamSSE(c, async (stream) => {
      const startedAt = Date.now()
      let tokensInput = 0
      let tokensOutput = 0
      try {
        const geminiHandle = await getGeminiClientForWorkspace(workspace.workspace_id)
        const ai = geminiHandle.genai
        const iter = await ai.models.generateContentStream({
          model,
          contents: contents as never,
          config: genConfig as never,
        })
        for await (const chunk of iter) {
          const text = chunk.text
          if (text) {
            await stream.writeSSE({
              event: 'token',
              data: JSON.stringify({ text }),
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
        const latencyMs = Date.now() - startedAt
        await recordLlmProxyUsage({
          workspaceId: workspace.workspace_id,
          accountId: workspace.account_id,
          model,
          tokensInput,
          tokensOutput,
          requestId,
          credentialMetadata: {
            credential_id: geminiHandle.credentialId,
            provenance: geminiHandle.provenance,
          },
        })
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            model,
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
            latency_ms: latencyMs,
          }),
        })
        logger.info(
          {
            requestId,
            workspace_id: workspace.workspace_id,
            model,
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
            latency_ms: latencyMs,
          },
          'llm request done',
        )
      } catch (err) {
        const errObj = err as Error
        logger.error(
          { requestId, err: { name: errObj.name, message: errObj.message } },
          'llm stream failed',
        )
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: 'stream_failed',
            code: 'gemini_error',
            message: errObj.message,
          }),
        })
      }
    })
  },
)

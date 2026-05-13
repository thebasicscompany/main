import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { grantDeepgramToken } from '../lib/deepgram.js'
import { DeepgramUnavailableError } from '../lib/errors.js'
import { dispatchCloudRun, UUID_RE } from '../lib/cloud-run-dispatch.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

// Empty body, .strict() rejects unknown fields.
const credentialsBodySchema = z.object({}).strict()
const voiceRunBodySchema = z.object({
  transcript: z.string().trim().min(1).max(64 * 1024),
  screenContext: z.unknown().optional(),
  cloudAgentId: z.string().regex(UUID_RE).optional(),
  laneId: z.string().regex(UUID_RE).optional(),
  conversationId: z.string().trim().min(1).max(512).optional(),
  model: z.string().trim().min(1).max(256).optional(),
}).strict()

type Vars = { requestId: string; workspace: WorkspaceToken }

export const voiceRoute = new Hono<{ Variables: Vars }>()

function compactJson(value: unknown): string {
  if (value === undefined) return 'null'
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ error: 'screen_context_not_serializable' })
  }
}

export function buildVoiceRunGoal(input: {
  transcript: string
  screenContext?: unknown
  conversationId?: string
}): string {
  const conversationBlock = input.conversationId
    ? `\nCONVERSATION ID:\n${input.conversationId}\n`
    : ''
  return [
    'This run was started by voice from the Double overlay.',
    'Use provided screen context as current user context.',
    'Ask for approval before external writes unless an existing trust grant allows it.',
    '',
    'VOICE REQUEST:',
    JSON.stringify(input.transcript),
    conversationBlock.trimEnd(),
    '',
    'SCREEN CONTEXT:',
    '```json',
    compactJson(input.screenContext),
    '```',
    '',
    'TASK:',
    'Interpret the request, use the existing harness/tools to complete it, and stream concise progress.',
  ].filter((part) => part.length > 0).join('\n')
}

/**
 * POST /v1/voice/credentials
 *
 * Issues a Deepgram scoped token (1h ttl) plus the public STT/TTS endpoints
 * the desktop overlay opens directly. Returns 503 if `DEEPGRAM_API_KEY`
 * is unset, 502 if the Deepgram grant API fails for any other reason.
 */
voiceRoute.post(
  '/credentials',
  zValidator('json', credentialsBodySchema, (result, c) => {
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
    const requestId = c.get('requestId')
    try {
      const workspace = c.get('workspace')
      const credentials = await grantDeepgramToken(requestId, workspace.workspace_id)
      return c.json(credentials, 200)
    } catch (err) {
      // Capability gate: env var missing → 503 (don't crash on boot).
      if (err instanceof DeepgramUnavailableError) {
        return c.json(
          { error: err.code, message: err.message },
          503,
        )
      }
      // Upstream provider failure → 502 with generic code (raw error logged in lib).
      logger.error(
        { requestId, err: { name: (err as Error).name, message: (err as Error).message } },
        'voice credentials route upstream failure',
      )
      return c.json(
        { error: 'upstream_unavailable', code: 'deepgram_grant_failed' },
        502,
      )
    }
  },
)

voiceRoute.post(
  '/runs',
  zValidator('json', voiceRunBodySchema, (result, c) => {
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
    const goal = buildVoiceRunGoal({
      transcript: body.transcript,
      screenContext: body.screenContext,
      conversationId: body.conversationId,
    })

    try {
      const result = await dispatchCloudRun({
        workspace: c.get('workspace'),
        goal,
        cloudAgentId: body.cloudAgentId,
        laneId: body.laneId,
        model: body.model,
        adHocDefinition: 'Voice-started opencode harness runs dispatched via POST /v1/voice/runs',
      })
      if (!result) return c.json({ error: 'not_found' }, 404)
      return c.json(result, 201)
    } catch (err) {
      if (err instanceof Error && err.message === 'runs_queue_not_configured') {
        return c.json({ error: 'runs_queue_not_configured' }, 503)
      }
      throw err
    }
  },
)

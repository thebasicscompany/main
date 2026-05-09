import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { grantDeepgramToken } from '../lib/deepgram.js'
import { DeepgramUnavailableError } from '../lib/errors.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

// Empty body, .strict() rejects unknown fields.
const voiceBodySchema = z.object({}).strict()

type Vars = { requestId: string; workspace: WorkspaceToken }

export const voiceRoute = new Hono<{ Variables: Vars }>()

/**
 * POST /v1/voice/credentials
 *
 * Issues a Deepgram scoped token (1h ttl) plus the public STT/TTS endpoints
 * the desktop overlay opens directly. Returns 503 if `DEEPGRAM_API_KEY`
 * is unset, 502 if the Deepgram grant API fails for any other reason.
 */
voiceRoute.post(
  '/',
  zValidator('json', voiceBodySchema, (result, c) => {
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

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getConfig } from '../config.js'
import type { WorkspaceToken } from '../lib/jwt.js'

const bootstrapBodySchema = z
  .object({
    client_installation_id: z.string().min(1).max(256),
    assistant_id: z.string().min(1).max(256),
    assistant_version: z.string().min(1).max(128).optional(),
    platform: z.enum(['macos']).or(z.string().min(1).max(64)),
    machine_name: z.string().min(1).max(256).optional(),
  })
  .strict()

type Vars = { requestId: string; workspace: WorkspaceToken }

export const desktopRoute = new Hono<{ Variables: Vars }>()

/**
 * POST /v1/desktop/bootstrap
 *
 * Idempotent desktop credential bootstrap for Basics Assistant.
 *
 * Returns Basics-native credential names sourced from the verified workspace
 * JWT. Any compatibility with old local readers belongs in the desktop /
 * assistant migration layer, not in this API contract.
 */
desktopRoute.post(
  '/bootstrap',
  zValidator('json', bootstrapBodySchema, (result, c) => {
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
  (c) => {
    const body = c.req.valid('json')
    const workspace = c.get('workspace')

    return c.json(
      {
        workspace_id: workspace.workspace_id,
        account_id: workspace.account_id,
        assistant_id: body.assistant_id,
        platform_base_url: 'https://api.trybasics.ai',
        assistant_api_key: c.req.header('X-Workspace-Token')
          ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
          ?? '',
        webhook_secret: null,
        credentials: {
          'basics:assistant_api_key': c.req.header('X-Workspace-Token')
            ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
            ?? '',
          'basics:platform_base_url': 'https://api.trybasics.ai',
          'basics:platform_assistant_id': body.assistant_id,
          'basics:workspace_id': workspace.workspace_id,
          'basics:account_id': workspace.account_id,
        },
        metadata: {
          client_installation_id: body.client_installation_id,
          assistant_version: body.assistant_version ?? null,
          platform: body.platform,
          machine_name: body.machine_name ?? null,
          token_expires_at: workspace.expires_at,
          environment: getConfig().NODE_ENV,
        },
      },
      200,
    )
  },
)

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getConfig } from '../config.js'
import { DatabaseUnavailableError } from '../lib/errors.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { rotateAssistantApiKey } from '../lib/workspace-api-keys.js'
import { getDesktopAssistantsRepo } from '../orchestrator/desktopAssistantsRepo.js'
import { logger } from '../middleware/logger.js'

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
  async (c) => {
    const body = c.req.valid('json')
    const workspace = c.get('workspace')
    const result = await getDesktopAssistantsRepo().ensureLocalRegistration({
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      clientInstallationId: body.client_installation_id,
      runtimeAssistantId: body.assistant_id,
      clientPlatform: body.platform,
      assistantVersion: body.assistant_version ?? null,
      machineName: body.machine_name ?? null,
    })

    if (!result.assistantApiKey) {
      await getDesktopAssistantsRepo().reprovisionLocalRegistration({
        workspaceId: workspace.workspace_id,
        accountId: workspace.account_id,
        clientInstallationId: body.client_installation_id,
        runtimeAssistantId: body.assistant_id,
        clientPlatform: body.platform,
        assistantVersion: body.assistant_version ?? null,
        machineName: body.machine_name ?? null,
      })
    }

    let assistantApiKey
    try {
      assistantApiKey = await rotateAssistantApiKey({
        workspaceId: workspace.workspace_id,
        accountId: workspace.account_id,
        clientInstallationId: body.client_installation_id,
        assistantId: result.assistant.id,
        assistantVersion: body.assistant_version ?? null,
        platform: body.platform,
        machineName: body.machine_name ?? null,
      })
    } catch (e) {
      if (e instanceof DatabaseUnavailableError) {
        return c.json({ error: 'not_configured' }, 503)
      }
      logger.error({ err: e }, 'desktop bootstrap api key create failed')
      throw e
    }

    const platformBaseUrl = 'https://api.trybasics.ai'

    return c.json(
      {
        workspace_id: workspace.workspace_id,
        account_id: workspace.account_id,
        assistant_id: result.assistant.id,
        platform_base_url: platformBaseUrl,
        assistant_api_key: assistantApiKey.key,
        assistant_api_key_id: assistantApiKey.meta.id,
        webhook_secret: null,
        credentials: {
          'basics:assistant_api_key': assistantApiKey.key,
          'basics:platform_base_url': platformBaseUrl,
          'basics:platform_assistant_id': result.assistant.id,
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

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WorkspaceToken } from '../lib/jwt.js'
import {
  ComposioClient,
  ComposioUnavailableError,
  getComposioApiKey,
  getComposioWebhookSecret,
  handleComposioLifecycleEvent,
  listComposioManagedSkills,
  normalizeConnectLink,
  SUPPORTED_COMPOSIO_WEBHOOK_EVENTS,
  verifyComposioWebhookSignature,
} from '../lib/composio.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const composioSkillsRoute = new Hono<{ Variables: Vars }>()
export const composioWebhookRoute = new Hono()

function composioUserId(workspace: WorkspaceToken): string {
  return workspace.account_id || workspace.workspace_id
}

function errorResponse(c: { json: (body: unknown, status: 500 | 502 | 503) => Response }, err: unknown) {
  if (err instanceof ComposioUnavailableError || !getComposioApiKey()) {
    return c.json({ error: 'capability_unavailable', capability: 'composio' }, 503)
  }
  const status = (err as { status?: number })?.status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return c.json({ error: 'composio_request_failed', status }, 502)
  }
  return c.json({ error: 'composio_request_failed' }, 500)
}

export async function managedComposioSkillsForWorkspace(
  workspace: WorkspaceToken,
): Promise<unknown[]> {
  if (!getComposioApiKey()) return []
  return listComposioManagedSkills(composioUserId(workspace))
}

composioSkillsRoute.get(
  '/composio/tools',
  zValidator(
    'query',
    z.object({
      toolkit_slug: z.string().optional(),
      q: z.string().optional(),
      auth_config_ids: z.string().optional(),
    }),
  ),
  async (c) => {
    try {
      const q = c.req.valid('query')
      const client = new ComposioClient()
      const tools = await client.listTools({
        toolkitSlug: q.toolkit_slug,
        query: q.q,
        authConfigIds: q.auth_config_ids,
      })
      return c.json({ tools })
    } catch (err) {
      return errorResponse(c, err)
    }
  },
)

composioSkillsRoute.post(
  '/composio/connect',
  zValidator(
    'json',
    z.object({
      authConfigId: z.string().min(1),
      callbackUrl: z.string().url().optional(),
    }),
  ),
  async (c) => {
    try {
      const body = c.req.valid('json')
      const client = new ComposioClient()
      const link = await client.createConnectLink(
        body.authConfigId,
        composioUserId(c.var.workspace),
        body.callbackUrl ? { callbackUrl: body.callbackUrl } : undefined,
      )
      return c.json(normalizeConnectLink(link))
    } catch (err) {
      return errorResponse(c, err)
    }
  },
)

composioSkillsRoute.delete('/composio/connections/:connectedAccountId', async (c) => {
  try {
    const connectedAccountId = c.req.param('connectedAccountId')?.trim()
    if (!connectedAccountId) return c.json({ error: 'invalid_request' }, 400)
    const client = new ComposioClient()
    await client.deleteConnectedAccount(connectedAccountId)
    return c.json({ ok: true })
  } catch (err) {
    return errorResponse(c, err)
  }
})

composioSkillsRoute.post(
  '/composio/tools/:toolSlug/execute',
  zValidator(
    'json',
    z.object({
      connectedAccountId: z.string().optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      text: z.string().optional(),
    }),
  ),
  async (c) => {
    try {
      const toolSlug = c.req.param('toolSlug')?.trim()
      if (!toolSlug) return c.json({ error: 'invalid_request' }, 400)
      const body = c.req.valid('json')
      if (!body.arguments && !body.text) return c.json({ error: 'invalid_request' }, 400)
      const client = new ComposioClient()
      return c.json(
        await client.executeTool(toolSlug, {
          userId: composioUserId(c.var.workspace),
          connectedAccountId: body.connectedAccountId,
          arguments: body.arguments,
          text: body.text,
        }),
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  },
)

composioWebhookRoute.post('/composio', async (c) => {
  const secret = getComposioWebhookSecret()
  if (!secret) return c.json({ error: 'Unauthorized' }, 401)

  const rawBody = await c.req.text()
  const verification = verifyComposioWebhookSignature({
    headers: c.req.raw.headers,
    rawBody,
    secret,
  })
  if (!verification.ok) return c.json({ error: 'Unauthorized' }, 401)

  const type = typeof verification.payload.type === 'string' ? verification.payload.type : undefined
  if (!type || !SUPPORTED_COMPOSIO_WEBHOOK_EVENTS.has(type)) {
    return c.json({ ok: true, ignored: true })
  }

  return c.json(handleComposioLifecycleEvent(verification.payload))
})

composioWebhookRoute.all('/composio', (c) => c.json({ error: 'Method not allowed' }, 405))

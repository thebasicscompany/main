import { createMiddleware } from 'hono/factory'
import { DatabaseUnavailableError } from '../lib/errors.js'
import { verifyWorkspaceToken, type WorkspaceToken } from '../lib/jwt.js'
import {
  authenticateWorkspaceApiKey,
  InvalidWorkspaceApiKeyError,
  WorkspaceApiKeyForbiddenError,
  type AuthenticatedWorkspaceApiKey,
} from '../lib/workspace-api-keys.js'

function extractToken(header: string | undefined): string | null {
  if (!header) return null
  const trimmed = header.trim()
  if (trimmed.length === 0) return null
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    const rest = trimmed.slice(7).trim()
    return rest.length > 0 ? rest : null
  }
  return trimmed
}

export type ManagedGatewayAuthVars = {
  workspace: WorkspaceToken
  apiKey?: AuthenticatedWorkspaceApiKey
}

/**
 * Managed gateway auth accepts either the existing workspace JWT or a durable
 * Basics API key. API keys are intentionally accepted only on this middleware,
 * not on every workspace route.
 */
export const requireManagedGatewayAuth = createMiddleware<{
  Variables: ManagedGatewayAuthVars
}>(async (c, next) => {
  const headerToken = c.req.header('X-Workspace-Token')
  const authHeader = c.req.header('Authorization')
  const token = extractToken(headerToken) ?? extractToken(authHeader)

  if (!token) {
    return c.json(
      { error: 'invalid_token', message: 'Missing workspace token or API key' },
      401,
    )
  }

  try {
    if (token.startsWith('bas_live_')) {
      const auth = await authenticateWorkspaceApiKey(token, 'llm:managed')
      c.set('workspace', auth.workspace)
      c.set('apiKey', auth.apiKey)
    } else {
      const decoded = await verifyWorkspaceToken(token)
      c.set('workspace', decoded)
    }
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured' }, 503)
    }
    if (err instanceof WorkspaceApiKeyForbiddenError) {
      return c.json({ error: 'forbidden', reason: err.reason }, 403)
    }
    const message = err instanceof Error ? err.message : 'Invalid token'
    const code = err instanceof InvalidWorkspaceApiKeyError ? 'invalid_api_key' : 'invalid_token'
    return c.json({ error: code, message }, 401)
  }

  await next()
})

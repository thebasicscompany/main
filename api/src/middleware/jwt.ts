import { createMiddleware } from 'hono/factory'
import { verifyWorkspaceToken, type WorkspaceToken } from '../lib/jwt.js'

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

/**
 * `requireWorkspaceJwt` — guard new runtime endpoints with the short-lived
 * workspace JWT issued by /v1/auth/token. Accepts the token in
 * `X-Workspace-Token` (preferred) or `Authorization: Bearer <token>`.
 *
 * IMPORTANT: This middleware does HS256 verification only. It does NOT
 * re-check workspace membership / subscription status against the DB —
 * those checks live in the legacy `authRequired` middleware and will
 * land later when runtime tables exist.
 *
 * On success: sets `c.var.workspace` to the decoded payload
 * (`{ workspace_id, account_id, plan, seat_status, ... }`).
 * On failure: returns `{ error: 'invalid_token', message }` 401.
 */
export const requireWorkspaceJwt = createMiddleware<{
  Variables: { workspace: WorkspaceToken }
}>(async (c, next) => {
  const headerToken = c.req.header('X-Workspace-Token')
  const authHeader = c.req.header('Authorization')
  const token = extractToken(headerToken) ?? extractToken(authHeader)

  if (!token) {
    return c.json(
      { error: 'invalid_token', message: 'Missing workspace token' },
      401,
    )
  }

  try {
    const decoded = await verifyWorkspaceToken(token)
    c.set('workspace', decoded)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    return c.json({ error: 'invalid_token', message }, 401)
  }

  await next()
})

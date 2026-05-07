/**
 * Cron-or-JWT auth middleware — Phase 10.5.
 *
 * Accepts EITHER:
 *   - workspace JWT (X-Workspace-Token / Authorization: Bearer ...), OR
 *   - shared cron secret in the X-Cron-Secret header.
 *
 * When called with a cron secret, the middleware does NOT populate
 * `c.var.workspace` (there's no workspace identity) — it sets a
 * `cronTrigger: true` flag on the context vars. The route handler is
 * responsible for resolving workspace_id from the workflow row by
 * `:id` param and continuing as if it had a workspace JWT.
 *
 * Locked decision (handoff): cron secret is the simplest path; we
 * deliberately avoid minting a service-account JWT (lifetime rotation
 * problem) or per-workspace cron tokens (extra table).
 *
 * Failure modes:
 *   - Neither header present → 401 invalid_token
 *   - X-Cron-Secret present but doesn't match RUNTIME_CRON_SECRET → 401
 *   - X-Cron-Secret present but RUNTIME_CRON_SECRET is unset on the
 *     server → 401 (treated as "secret doesn't match").
 *   - Workspace JWT present and valid → behaves exactly like the
 *     existing requireWorkspaceJwt middleware.
 *   - Both headers present → workspace JWT wins (precedence: humans
 *     before cron, since a logged-in user explicitly hitting run-now
 *     is the more specific intent).
 */

import { createMiddleware } from 'hono/factory'
import { getConfig } from '../config.js'
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
 * Constant-time string compare to avoid leaking secret bytes via timing.
 * Both inputs must be plain ASCII / UTF-8 strings.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export type CronAuthVariables = {
  workspace?: WorkspaceToken
  cronTrigger?: boolean
}

/**
 * Middleware that accepts workspace-JWT OR shared cron secret. Use on
 * the `/run-now` route specifically — the rest of the workflows surface
 * stays JWT-only.
 */
export const requireCronOrWorkspaceJwt = createMiddleware<{
  Variables: CronAuthVariables
}>(async (c, next) => {
  // Workspace JWT path takes precedence — a real user beats cron.
  const headerToken = c.req.header('X-Workspace-Token')
  const authHeader = c.req.header('Authorization')
  const token = extractToken(headerToken) ?? extractToken(authHeader)

  if (token) {
    try {
      const decoded = await verifyWorkspaceToken(token)
      c.set('workspace', decoded)
      c.set('cronTrigger', false)
      await next()
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      return c.json({ error: 'invalid_token', message }, 401)
    }
  }

  // No JWT — fall back to cron-secret auth.
  const cronSecret = c.req.header('X-Cron-Secret')
  if (cronSecret) {
    const expected = getConfig().RUNTIME_CRON_SECRET
    if (!expected) {
      return c.json(
        {
          error: 'invalid_token',
          message: 'cron secret presented but server has none configured',
        },
        401,
      )
    }
    if (!timingSafeEqual(cronSecret, expected)) {
      return c.json(
        { error: 'invalid_token', message: 'cron secret mismatch' },
        401,
      )
    }
    c.set('cronTrigger', true)
    await next()
    return
  }

  return c.json(
    {
      error: 'invalid_token',
      message: 'Missing workspace token or cron secret',
    },
    401,
  )
})

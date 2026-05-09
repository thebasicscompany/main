import { createMiddleware } from 'hono/factory'
import type { WorkspaceToken } from '../lib/jwt.js'

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

/** Simple fixed-window counter per workspace (default 100 req / minute). */
export function rateLimitManagedProxy(limit = 100, windowMs = 60_000) {
  return createMiddleware<{ Variables: { workspace: WorkspaceToken } }>(async (c, next) => {
    const ws = c.var.workspace.workspace_id
    const now = Date.now()
    let b = buckets.get(ws)
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs }
      buckets.set(ws, b)
    }
    if (b.count >= limit) {
      return c.json({ error: 'rate_limited', reason: 'managed_proxy_quota' }, 429)
    }
    b.count++
    await next()
  })
}

export function __resetManagedProxyRateLimitsForTests(): void {
  buckets.clear()
}

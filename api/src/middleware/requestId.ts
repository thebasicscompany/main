import { createMiddleware } from 'hono/factory'
import { randomUUID } from 'node:crypto'

type Vars = { requestId: string }

// RFC 4122 v4 / v7 UUID validator (same shape both versions emit).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Reads `X-Request-Id` from the incoming request — or generates a new
 * UUID if missing / malformed — and pins it on `c.var.requestId` and the
 * response header. Downstream logger middleware reads this for trace
 * correlation.
 */
export const requestIdMiddleware = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const incoming = c.req.header('X-Request-Id') ?? ''
  const requestId = incoming && isValidUuid(incoming) ? incoming : randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  await next()
})

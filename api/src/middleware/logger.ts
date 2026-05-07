import { createMiddleware } from 'hono/factory'
import pino from 'pino'
import { getConfig } from '../config.js'
import type { WorkspaceToken } from '../lib/jwt.js'

// Read config defensively at module load — tests / lambda boot may import
// the logger before env validation has run successfully.
const cfg = (() => {
  try {
    return getConfig()
  } catch {
    return null
  }
})()

export const logger = pino({
  level: cfg?.LOG_LEVEL ?? 'info',
  ...(cfg?.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
  // Defensive: redact auth-bearing headers if request logs are extended later.
  redact: {
    paths: [
      'req.headers["x-workspace-token"]',
      'req.headers.authorization',
    ],
    remove: true,
  },
})

type Vars = { requestId: string; workspace?: WorkspaceToken }

export const loggerMiddleware = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const start = Date.now()
  await next()
  const durationMs = Date.now() - start
  const ws = c.get('workspace') as WorkspaceToken | undefined
  logger.info({
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs,
    ...(ws ? { workspace_id: ws.workspace_id, account_id: ws.account_id } : {}),
  })
})

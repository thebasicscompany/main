import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestIdMiddleware } from './middleware/requestId.js'
import { loggerMiddleware, logger } from './middleware/logger.js'
import { requireWorkspaceJwt } from './middleware/jwt.js'
import { getConfig } from './config.js'
import { healthRoute, runtimeHealthRoute } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { voiceRoute } from './routes/voice.js'
import { llmRoute } from './routes/llm.js'
import { runsRoute } from './routes/runs.js'
import { contextsRoute } from './routes/contexts.js'
import { trustGrantsRoute } from './routes/trust-grants.js'
import { workflowsRoute } from './routes/workflows.js'
import { desktopRoute } from './routes/desktop.js'
import type { WorkspaceToken } from './lib/jwt.js'

export type AppVariables = { requestId: string; workspace?: WorkspaceToken }

/**
 * Build the runtime API Hono app.
 *
 * CORS allowlist:
 *  - `null` origin (Electron desktop app — file:// requests have null origin)
 *  - `http://localhost:5173` (Vite dev)
 *  - any origin in `BASICS_ALLOWED_ORIGINS` (comma-separated)
 *
 * Middleware order: cors → requestId → logger → routes → onError.
 *
 * Mount surface (intentionally minimal — see PORT plan):
 *   /health                       (public)
 *   /v1/auth/token                (public, takes Supabase access token)
 *   /v1/desktop/bootstrap         (workspace JWT)
 *   /v1/voice/credentials         (workspace JWT)
 *   /v1/llm                       (workspace JWT)
 *   /v1/runtime/health            (workspace JWT)
 *
 * Legacy agent routes (agents, conversations, brain, memory, captures, etc.)
 * are intentionally NOT mounted here — runtime is a clean-room rebuild and
 * those routes will be ported individually as their tables land.
 */
export function buildApp() {
  const app = new Hono<{ Variables: AppVariables }>()

  const cfg = getConfig()

  // Default allowlist: Electron (`null` origin) + Vite dev. Operator can
  // extend via BASICS_ALLOWED_ORIGINS env (comma-separated). Throw at boot
  // if the env var is set but parses to zero entries to avoid silent deny-all.
  const baseOrigins = ['null', 'http://localhost:5173']
  let allowedOrigins: string[] = baseOrigins
  if (cfg.BASICS_ALLOWED_ORIGINS) {
    const extra = cfg.BASICS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (extra.length === 0) {
      throw new Error('BASICS_ALLOWED_ORIGINS is set but empty after parsing')
    }
    allowedOrigins = [...baseOrigins, ...extra]
  }

  app.use(
    '*',
    cors({
      origin: (origin) => {
        // hono/cors invokes this with the raw incoming Origin header.
        // For Electron / file:// requests the browser sends `null` (string),
        // which we explicitly allow.
        if (allowedOrigins.includes(origin)) return origin
        return null
      },
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'X-Workspace-Token',
        'X-Request-Id',
        'X-Cron-Secret',
      ],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 86400,
    }),
  )
  app.use('*', requestIdMiddleware)
  app.use('*', loggerMiddleware)

  // Unprotected.
  app.route('/health', healthRoute)

  // Public — takes a Supabase access token in body, mints workspace JWT.
  app.route('/v1/auth', authRoutes)

  // Workspace-JWT-protected routes.
  app.use('/v1/desktop/*', requireWorkspaceJwt)
  app.route('/v1/desktop', desktopRoute)

  app.use('/v1/voice/credentials/*', requireWorkspaceJwt)
  app.route('/v1/voice/credentials', voiceRoute)

  app.use('/v1/llm/*', requireWorkspaceJwt)
  app.route('/v1/llm', llmRoute)

  // runtimeHealthRoute applies requireWorkspaceJwt internally.
  app.route('/v1/runtime/health', runtimeHealthRoute)

  app.use('/v1/runtime/runs/*', requireWorkspaceJwt)
  app.route('/v1/runtime/runs', runsRoute)

  app.use('/v1/runtime/contexts/*', requireWorkspaceJwt)
  app.route('/v1/runtime/contexts', contextsRoute)

  app.use('/v1/runtime/trust-grants/*', requireWorkspaceJwt)
  app.route('/v1/runtime/trust-grants', trustGrantsRoute)

  // Phase 10.5: workflows route applies auth per-route (CRUD =
  // requireWorkspaceJwt; run-now = requireCronOrWorkspaceJwt) so
  // EventBridge can invoke run-now with a shared cron secret instead
  // of a JWT. Do NOT add a prefix-wide guard here — it would 401
  // every cron-fired call.
  app.route('/v1/runtime/workflows', workflowsRoute)

  app.onError((err, c) => {
    const cause = (err as Error & { cause?: unknown }).cause
    const causeInfo =
      cause instanceof Error
        ? {
            message: cause.message,
            code: (cause as Error & { code?: string }).code,
            stack: cause.stack,
          }
        : cause
    logger.error(
      {
        requestId: c.get('requestId'),
        err: { message: err.message, stack: err.stack, cause: causeInfo },
      },
      'unhandled error',
    )
    return c.json({ error: 'internal_error' }, 500)
  })

  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  return app
}

// Build lazily so test files can control env var initialization order.
export const app = buildApp()

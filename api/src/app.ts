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
import { contextsRoute } from './routes/contexts.js'
import { desktopRoute } from './routes/desktop.js'
import { platformRoute } from './routes/platform.js'
import { cloudChatRoute } from './routes/cloud-chat.js'
import { cloudMemoryRoute } from './routes/cloud-memory.js'
import { assistantCompatRoute } from './routes/assistant-compat.js'
import { credentialRoutes } from './routes/credentials.js'
import { gatewayCredentialBridge } from './middleware/gateway-credential-bridge.js'
import { requireManagedGatewayAuth } from './middleware/managed-gateway-auth.js'
import { rateLimitManagedProxy } from './middleware/rate-limit-managed-proxy.js'
import { cloudRunsRoute } from './routes/cloud-runs.js'
import { cloudSkillsRoute } from './routes/cloud-skills.js'
import { composioSkillsRoute, composioWebhookRoute } from './routes/composio.js'
import { cloudSchedulesRoute } from './routes/cloud-schedules.js'
import {
  approvalsRoute,
  workspaceApprovalsRoute,
  runApprovalsRoute,
} from './routes/approvals.js'
import { sendblueInboundRoute } from './routes/sendblue-inbound.js'
import { automationsRoute, dryRunPreviewRoute } from './routes/automations.js'
import { browserSitesRoute } from './routes/browser-sites.js'
import type { WorkspaceToken } from './lib/jwt.js'
import type { AuthenticatedWorkspaceApiKey } from './lib/workspace-api-keys.js'

export type AppVariables = {
  requestId: string
  workspace?: WorkspaceToken
  apiKey?: AuthenticatedWorkspaceApiKey
}

/**
 * Build the runtime API Hono app.
 *
 * CORS allowlist:
 *  - `null` origin (Electron desktop app — file:// requests have null origin)
 *  - `http://localhost:5173` (Vite dev)
 *  - any origin in `BASICS_ALLOWED_ORIGINS` (comma-separated)
 *
 * Middleware order: cors → requestId → logger → routes → onError.
 */
export function buildApp() {
  const app = new Hono<{ Variables: AppVariables }>()

  const cfg = getConfig()

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
        if (allowedOrigins.includes(origin)) return origin
        return null
      },
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'X-Workspace-Token',
        'X-Request-Id',
        'X-Cron-Secret',
        'X-Basics-Client-Id',
        'X-Vellum-Client-Id',
        'X-Basics-Interface-Id',
        'X-Vellum-Interface-Id',
        'X-Basics-Machine-Name',
        'X-Vellum-Machine-Name',
      ],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 86400,
    }),
  )
  app.use('*', requestIdMiddleware)
  app.use('*', loggerMiddleware)

  app.route('/health', healthRoute)
  app.route('/v1/auth', authRoutes)
  app.route('/webhooks', composioWebhookRoute)
  // C.6 — Sendblue inbound webhook for reply-to-approve SMS flow.
  // No JWT — phone-pair auth (from_number ↔ workspace.approval_phone).
  app.route('/webhooks', sendblueInboundRoute)

  app.use('/v1/desktop/*', requireWorkspaceJwt)
  app.route('/v1/desktop', desktopRoute)

  app.use('/v1/assistants', requireWorkspaceJwt)
  app.use('/v1/assistants/*', requireWorkspaceJwt)
  app.route('/v1/assistants', assistantCompatRoute)
  app.route('/v1/assistants', cloudChatRoute)
  app.route('/v1/assistants', cloudMemoryRoute)
  app.use('/v1/organizations', requireWorkspaceJwt)
  app.use('/v1/organizations/*', requireWorkspaceJwt)
  app.route('/v1', platformRoute)

  app.use('/v1/voice/credentials/*', requireWorkspaceJwt)
  app.route('/v1/voice/credentials', voiceRoute)

  app.use('/v1/llm/managed/*', requireManagedGatewayAuth)
  app.use('/v1/llm/managed/*', rateLimitManagedProxy())
  app.all('/v1/llm/managed/*', gatewayCredentialBridge)
  app.use('/v1/llm/*', requireWorkspaceJwt)
  app.route('/v1/llm', llmRoute)

  app.use('/v1/workspaces/*', requireWorkspaceJwt)
  app.route('/v1/workspaces', credentialRoutes)
  // C.5 — GET /v1/workspaces/:wsId/approvals (JWT covered by /v1/workspaces/* middleware above).
  app.route('/v1/workspaces', workspaceApprovalsRoute)
  // E.4 — POST/GET/DELETE /v1/workspaces/:wsId/browser-sites[/:host[/{connect,finalize}]]
  app.route('/v1/workspaces', browserSitesRoute)

  // C.5 — /v1/approvals routes carry their OWN auth (workspace JWT OR
  // signed access token via ?token=); intentionally no blanket middleware.
  app.route('/v1/approvals', approvalsRoute)

  app.route('/v1/runtime/health', runtimeHealthRoute)

  app.use('/v1/runtime/contexts/*', requireWorkspaceJwt)
  app.route('/v1/runtime/contexts', contextsRoute)

  // Phase H — cloud-agent control-plane.
  //   POST   /v1/runs                                       — dispatch one-shot
  //   GET    /v1/runs?cloudAgentId=…&limit=&since=          — list past runs
  //   GET    /v1/runs/:id/events                            — SSE stream
  //   POST   /v1/skills/:id/approve|reject  + GET/PATCH/DELETE
  //   POST   /v1/schedules + GET/PATCH/DELETE/:id/test
  app.use('/v1/runs', requireWorkspaceJwt)
  app.use('/v1/runs/*', requireWorkspaceJwt)
  app.route('/v1/runs', cloudRunsRoute)
  // C.5 — POST /v1/runs/:runId/approvals/bulk uses the same JWT scope as
  // the rest of /v1/runs/*; mount after cloudRunsRoute so it doesn't get
  // shadowed.
  app.route('/v1/runs', runApprovalsRoute)
  // E.8 — GET /v1/runs/:runId/dry-run-preview (workspace JWT covered by
  // the /v1/runs/* middleware above).
  app.route('/v1/runs', dryRunPreviewRoute)
  app.use('/v1/skills', requireWorkspaceJwt)
  app.use('/v1/skills/*', requireWorkspaceJwt)
  app.route('/v1/skills', composioSkillsRoute)
  app.route('/v1/skills', cloudSkillsRoute)
  app.use('/v1/schedules', requireWorkspaceJwt)
  app.use('/v1/schedules/*', requireWorkspaceJwt)
  app.route('/v1/schedules', cloudSchedulesRoute)

  // D.2 — Automations CRUD.
  app.use('/v1/automations', requireWorkspaceJwt)
  app.use('/v1/automations/*', requireWorkspaceJwt)
  app.route('/v1/automations', automationsRoute)

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

export const app = buildApp()

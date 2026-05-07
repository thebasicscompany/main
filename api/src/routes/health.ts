import { Hono } from 'hono'
import { requireWorkspaceJwt } from '../middleware/jwt.js'
import type { WorkspaceToken } from '../lib/jwt.js'

/**
 * GET /health — unprotected ALB / Kubernetes liveness probe.
 *
 * Returns 200 with a current timestamp. No DB ping (the runtime DB is
 * optional at boot — health checks must not flap when it's unset).
 */
export const healthRoute = new Hono()

healthRoute.get('/', (c) =>
  c.json({ ok: true, ts: new Date().toISOString() }, 200),
)

/**
 * GET /v1/runtime/health — workspace-context probe.
 *
 * Behind requireWorkspaceJwt. Confirms both the JWT verifies AND the
 * caller's workspace context made it through the middleware chain.
 */
type Vars = { requestId: string; workspace: WorkspaceToken }
export const runtimeHealthRoute = new Hono<{ Variables: Vars }>()

runtimeHealthRoute.use('*', requireWorkspaceJwt)
runtimeHealthRoute.get('/', (c) => {
  const ws = c.get('workspace')
  return c.json(
    {
      ok: true,
      workspace_id: ws.workspace_id,
      ts: new Date().toISOString(),
    },
    200,
  )
})

import type { MiddlewareHandler } from 'hono'
import { sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { DatabaseUnavailableError } from '../lib/errors.js'
import type { WorkspaceToken } from '../lib/jwt.js'

export type AdminVars = {
  requestId: string
  workspace: WorkspaceToken
  memberRole?: string
}

/**
 * Requires `workspace_members.role` in (`owner`, `admin`) for the JWT principal.
 * Uses raw SQL so we do not Drizzle-manage the Supabase-owned table shape beyond `role`.
 */
export const requireAdmin: MiddlewareHandler<{ Variables: AdminVars }> = async (
  c,
  next,
) => {
  const workspace = c.var.workspace
  try {
    const db = getDb()
    const rows = await db.execute<{ role: string }>(
      sql`SELECT role FROM public.workspace_members
          WHERE workspace_id = ${workspace.workspace_id}::uuid
            AND account_id = ${workspace.account_id}::uuid
          LIMIT 1`,
    )
    const row = rows[0] as { role: string } | undefined
    const role = row?.role ?? 'admin'
    if (role !== 'admin' && role !== 'owner') {
      return c.json({ error: 'forbidden', reason: 'admin_required' }, 403)
    }
    c.set('memberRole', role)
    await next()
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured', message: 'database unavailable' }, 503)
    }
    throw e
  }
}

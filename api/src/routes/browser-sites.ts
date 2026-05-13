/**
 * E.4 — Per-host browser-session credentials.
 *
 *   POST   /v1/workspaces/:workspaceId/browser-sites/:host/connect
 *   POST   /v1/workspaces/:workspaceId/browser-sites/:host/finalize
 *   GET    /v1/workspaces/:workspaceId/browser-sites
 *   DELETE /v1/workspaces/:workspaceId/browser-sites/:host
 *
 * All routes require a workspace JWT (mounted under the existing
 * `/v1/workspaces/*` middleware in app.ts). The JWT's workspace_id MUST
 * match the path :workspaceId — we cross-check on every handler so a
 * leaked token can't address a different workspace.
 *
 * Storage model: the row's `storage_state_json` column stashes a
 * pointer to a Browserbase Context (not the raw cookies + localStorage —
 * Browserbase itself holds those). The worker's E.2 loader returns the
 * pointer; future worker integration will pass `contextId` to
 * `createSession({ contextId, persistContext: true })` so the agent boots
 * into the operator's saved state.
 *
 *   pending     : { kind: 'browserbase_context_pending',
 *                   contextId: 'ctx_…', sessionId: 'sess_…',
 *                   initialUrl: 'https://…' }
 *   finalized   : { kind: 'browserbase_context', contextId: 'ctx_…' }
 *
 * Pending rows expire fast (30 min, matching the Browserbase session
 * default) so an abandoned connect doesn't shadow a real saved state for
 * the same (workspace_id, host) pair. On finalize we extend to 60 days.
 *
 * Endpoints NEVER return `storage_state_json` in the response — pointers
 * to Browserbase Contexts are operationally sensitive (anyone with the
 * contextId + project API key could pin a fresh session to that state).
 */

import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  createContext,
  createSession,
  stopSession,
} from '../lib/browserbase.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }
type HCtx = Context<{ Variables: Vars }>

export const browserSitesRoute = new Hono<{ Variables: Vars }>()

const UUID_RE = /^[0-9a-fA-F-]{36}$/
const HOST_RE = /^[a-z0-9.-]+$/

function badHost(c: HCtx) {
  return c.json(
    { error: 'invalid_host', message: 'host must match /^[a-z0-9.-]+$/' },
    400,
  )
}

function badWorkspaceId(c: HCtx) {
  return c.json({ error: 'invalid_workspace_id' }, 400)
}

function forbidden(c: HCtx) {
  return c.json({ error: 'forbidden' }, 403)
}

/** Cross-check that the JWT's workspace matches the URL's :workspaceId.
 *  Returns the resolved workspace_id when ok, else null (caller returns 4xx). */
function guardWorkspace(
  c: HCtx,
  pathWorkspaceId: string,
): { workspaceId: string; accountId: string } | null {
  const tok = c.var.workspace
  if (!tok) return null
  if (!UUID_RE.test(pathWorkspaceId)) return null
  if (tok.workspace_id !== pathWorkspaceId) return null
  return { workspaceId: tok.workspace_id, accountId: tok.account_id }
}

interface StorageStatePointer {
  kind: 'browserbase_context_pending' | 'browserbase_context'
  contextId: string
  sessionId?: string
  initialUrl?: string
}

interface BrowserSiteRow {
  workspace_id: string
  host: string
  display_name: string | null
  storage_state_json: unknown
  captured_via: string
  last_verified_at: string | null
  expires_at: string
  created_by: string | null
  created_at: string
  updated_at: string
}

const ConnectBody = z.object({
  initialUrl: z.string().url().max(2048).optional(),
  displayName: z.string().min(1).max(200).optional(),
})
const FinalizeBody = z.object({
  sessionId: z.string().min(1).max(200),
})

// ─── POST connect ────────────────────────────────────────────────────────

browserSitesRoute.post(
  '/:workspaceId/browser-sites/:host/connect',
  zValidator('json', ConnectBody.optional().default({})),
  async (c) => {
    const pathWs = c.req.param('workspaceId')
    const host = (c.req.param('host') ?? '').toLowerCase()
    if (!HOST_RE.test(host)) return badHost(c)
    const scope = guardWorkspace(c, pathWs)
    if (!scope) return UUID_RE.test(pathWs) ? forbidden(c) : badWorkspaceId(c)

    const body = (c.req.valid('json') ?? {}) as z.infer<typeof ConnectBody>
    const initialUrl =
      body.initialUrl && body.initialUrl.length > 0
        ? body.initialUrl
        : `https://${host}/`

    // Fresh Context per connect — if the operator is replacing a stale
    // session for the same host, we'll overwrite the row on finalize and
    // the prior contextId is orphaned in Browserbase (cheap; no per-Context
    // billing). Cleanest mental model: one Context = one captured login.
    const ctx = await createContext()
    const session = await createSession({
      workspaceId: scope.workspaceId,
      runId: `browser-sites-connect-${host}`,
      contextId: ctx.contextId,
      persistContext: true,
      // 30-minute session ceiling — operator should be done in under 5.
      timeoutMs: 30 * 60_000,
    })

    const pendingPtr: StorageStatePointer = {
      kind: 'browserbase_context_pending',
      contextId: ctx.contextId,
      sessionId: session.sessionId,
      initialUrl,
    }

    // 30-minute pending TTL — finalize bumps to 60d. Display name defaults
    // to the host so the list endpoint has something to show before the
    // operator finishes signing in.
    await db.execute(sql`
      INSERT INTO public.workspace_browser_sites
        (workspace_id, host, display_name, storage_state_json,
         captured_via, last_verified_at, expires_at, created_by)
      VALUES
        (${scope.workspaceId}, ${host},
         ${body.displayName ?? host},
         ${JSON.stringify(pendingPtr)}::jsonb,
         'browserbase_liveview',
         NULL,
         now() + interval '30 minutes',
         ${scope.accountId})
      ON CONFLICT (workspace_id, host) DO UPDATE
        SET display_name        = EXCLUDED.display_name,
            storage_state_json  = EXCLUDED.storage_state_json,
            captured_via        = EXCLUDED.captured_via,
            last_verified_at    = NULL,
            expires_at          = EXCLUDED.expires_at,
            created_by          = EXCLUDED.created_by,
            updated_at          = now()
    `)

    return c.json(
      {
        sessionId: session.sessionId,
        liveViewUrl: session.liveUrl,
        host,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
      201,
    )
  },
)

// ─── POST finalize ───────────────────────────────────────────────────────

browserSitesRoute.post(
  '/:workspaceId/browser-sites/:host/finalize',
  zValidator('json', FinalizeBody),
  async (c) => {
    const pathWs = c.req.param('workspaceId')
    const host = (c.req.param('host') ?? '').toLowerCase()
    if (!HOST_RE.test(host)) return badHost(c)
    const scope = guardWorkspace(c, pathWs)
    if (!scope) return UUID_RE.test(pathWs) ? forbidden(c) : badWorkspaceId(c)

    const { sessionId } = c.req.valid('json')

    // Find the pending row that owns this sessionId. Cross-check host so
    // a stolen sessionId can't move to a different host's row.
    const rows = (await db.execute(sql`
      SELECT workspace_id, host, storage_state_json
        FROM public.workspace_browser_sites
       WHERE workspace_id = ${scope.workspaceId}
         AND host = ${host}
         AND storage_state_json @> ${JSON.stringify({
           kind: 'browserbase_context_pending',
           sessionId,
         })}::jsonb
       LIMIT 1
    `)) as unknown as Array<{ storage_state_json: StorageStatePointer }>

    const row = rows[0]
    if (!row) {
      return c.json(
        { error: 'pending_session_not_found', sessionId, host },
        404,
      )
    }
    const contextId = row.storage_state_json.contextId

    // Stopping the session is what tells Browserbase to persist cookies +
    // localStorage back into the Context. Best-effort: if the session has
    // already timed out, the persist still happened on session-end.
    await stopSession(sessionId).catch(() => undefined)

    const finalizedPtr: StorageStatePointer = {
      kind: 'browserbase_context',
      contextId,
    }
    const ptrJson = JSON.stringify(finalizedPtr)

    await db.execute(sql`
      UPDATE public.workspace_browser_sites
         SET storage_state_json = ${ptrJson}::jsonb,
             last_verified_at   = now(),
             expires_at         = now() + interval '60 days',
             updated_at         = now()
       WHERE workspace_id = ${scope.workspaceId}
         AND host         = ${host}
    `)

    return c.json({
      ok: true,
      host,
      expiresAt: new Date(Date.now() + 60 * 24 * 3600_000).toISOString(),
      sizeBytes: ptrJson.length,
    })
  },
)

// ─── GET list ────────────────────────────────────────────────────────────

browserSitesRoute.get('/:workspaceId/browser-sites', async (c) => {
  const pathWs = c.req.param('workspaceId')
  const scope = guardWorkspace(c, pathWs)
  if (!scope) return UUID_RE.test(pathWs) ? forbidden(c) : badWorkspaceId(c)

  const rows = (await db.execute(sql`
    SELECT host,
           display_name,
           captured_via,
           last_verified_at::text     AS last_verified_at,
           expires_at::text            AS expires_at,
           (expires_at > now())        AS is_active,
           (expires_at > now()
             AND expires_at < now() + interval '7 days') AS is_expiring,
           (storage_state_json->>'kind') AS pointer_kind
      FROM public.workspace_browser_sites
     WHERE workspace_id = ${scope.workspaceId}
     ORDER BY host
  `)) as unknown as Array<{
    host: string
    display_name: string | null
    captured_via: string
    last_verified_at: string | null
    expires_at: string
    is_active: boolean
    is_expiring: boolean
    pointer_kind: string
  }>

  const items = rows.map((r) => ({
    host: r.host,
    displayName: r.display_name,
    capturedVia: r.captured_via,
    lastVerifiedAt: r.last_verified_at,
    expiresAt: r.expires_at,
    status:
      r.pointer_kind === 'browserbase_context_pending'
        ? 'pending'
        : !r.is_active
          ? 'expired'
          : r.is_expiring
            ? 'expiring'
            : 'active',
  }))

  return c.json({ items })
})

// ─── DELETE ──────────────────────────────────────────────────────────────

browserSitesRoute.delete('/:workspaceId/browser-sites/:host', async (c) => {
  const pathWs = c.req.param('workspaceId')
  const host = (c.req.param('host') ?? '').toLowerCase()
  if (!HOST_RE.test(host)) return badHost(c)
  const scope = guardWorkspace(c, pathWs)
  if (!scope) return UUID_RE.test(pathWs) ? forbidden(c) : badWorkspaceId(c)

  const rows = (await db.execute(sql`
    DELETE FROM public.workspace_browser_sites
     WHERE workspace_id = ${scope.workspaceId}
       AND host = ${host}
     RETURNING host
  `)) as unknown as Array<{ host: string }>

  return c.json({ deleted: rows.length > 0, host })
})

export type { BrowserSiteRow, StorageStatePointer }

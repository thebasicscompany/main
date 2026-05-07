/**
 * /v1/runtime/contexts — Phase 07 (Lens cookie/state sync, runtime side).
 *
 *   POST /v1/runtime/contexts/sync                                   — accept a cookie payload
 *   GET  /v1/runtime/contexts/me                                     — read sync status for the calling workspace
 *
 * Auth: workspace JWT (mounted in app.ts via requireWorkspaceJwt).
 *
 * Locked decision (HANDOFF.md, DESKTOP_INTEGRATION.md finding #3):
 *  - The desktop's existing TS cookie extractor stays. This route accepts
 *    the *same payload shape* that desktop already sends to agent/'s
 *    `/v1/cookie-sync/upload`, so the desktop's `uploadCookieSync` can be
 *    repointed by URL flip alone.
 *  - We reuse `public.workspaces.browserbase_profile_id` and
 *    `last_cookie_sync_at` (added by agent/) instead of creating a new
 *    `runtime_contexts` table. ARCHITECTURE.md still references that table
 *    — the HANDOFF supersedes.
 *  - Browserbase Context API: raw fetch via `lib/browserbase.ts` (no SDK).
 *  - CDP attach via `chrome-remote-interface` MUST use `local: true`
 *    (HANDOFF gotcha #1) — the harness's `attach` already does this.
 *
 * Privacy: cookie *values* never persist in runtime Postgres and are not
 * logged. Only the resulting Browserbase Context id, sync timestamp, and
 * domain summaries are written.
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  BrowserbaseUnavailableError,
  InternalError,
  handleError,
} from '../lib/errors.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import {
  createContext as createBrowserbaseContext,
} from '../lib/browserbase.js'
import {
  defaultSyncDeps,
  syncCookiesToContext,
  type SyncCookiesToContextDeps,
} from '../lib/contextSync.js'
import { logger } from '../middleware/logger.js'
import {
  getSnapshot as getContextSnapshot,
  markSynced as markWorkspaceSynced,
  setContextId as setWorkspaceContextId,
} from '../orchestrator/workspaceContextRepo.js'

// ── Payload schema ────────────────────────────────────────────────────
//
// Mirrors agent/'s /v1/cookie-sync/upload contract verbatim — see
// agent/api/src/routes/chromeImport.ts CookieSchema + UploadBody. Desktop
// already serializes to this shape.

const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().default('/'),
  expires: z.number().default(-1),
  size: z.number().default(0),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  session: z.boolean().default(false),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
})

const LocalStorageItemSchema = z.object({
  securityOrigin: z.string().min(1),
  key: z.string(),
  value: z.string(),
})

// 50_000 cookie cap matches agent/'s mitigation — above this the payload is
// almost certainly junk / years of expired entries.
const SyncBody = z.object({
  cookies: z.array(CookieSchema).min(0).max(50_000),
  profile_label: z.string().min(1).max(100),
  profile_directory: z.string().max(200).optional(),
  /** Optional include-domains filter (e.g. ["salesforce.com",
   *  "hubspot.com"]). When set, cookies outside the list are dropped. */
  domains: z.array(z.string().min(1)).max(200).optional(),
  /** Optional localStorage entries. Phase 07 v1 desktop doesn't send
   *  these; the field is here so a future Lens pass that ships
   *  localStorage doesn't need a route change. */
  local_storage: z.array(LocalStorageItemSchema).max(50_000).optional(),
})

type Vars = { requestId: string; workspace: WorkspaceToken }

// =============================================================================
// DI seam — production wires the real Browserbase + CDP attach factory;
// tests inject a stub so the route handler can be exercised without
// touching real Browserbase or spawning a Chrome.
// =============================================================================

let depsOverride: SyncCookiesToContextDeps | null = null
let createContextOverride: (() => Promise<{ contextId: string }>) | null = null

/** Test-only: install stub deps for the duration of a test. */
export function __setSyncDepsForTests(
  deps: SyncCookiesToContextDeps | null,
): void {
  depsOverride = deps
}

/** Test-only: install a stub for `createContext`. */
export function __setCreateContextForTests(
  fn: (() => Promise<{ contextId: string }>) | null,
): void {
  createContextOverride = fn
}

async function resolveSyncDeps(): Promise<SyncCookiesToContextDeps> {
  if (depsOverride) return depsOverride
  return defaultSyncDeps()
}

async function resolveCreateContext(): Promise<() => Promise<{ contextId: string }>> {
  if (createContextOverride) return createContextOverride
  return async () => createBrowserbaseContext()
}

export const contextsRoute = new Hono<{ Variables: Vars }>()

/**
 * POST /v1/runtime/contexts/sync — inject the supplied cookie payload into
 * the calling workspace's Browserbase Context.
 *
 * On first sync the workspace has no `browserbase_profile_id` — we create
 * a fresh Context, write the id back, and proceed. On subsequent syncs the
 * existing Context is reused (idempotent re-sync overwrites the cookie jar).
 */
contextsRoute.post(
  '/sync',
  zValidator('json', SyncBody, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'validation_error',
          message: 'invalid cookie payload',
          details: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  async (c) => {
    const requestId = c.get('requestId')
    const workspace = c.get('workspace')
    const body = c.req.valid('json')

    // Cookie *values* are sensitive — domain summary is what we log.
    const domainSet = new Set<string>()
    for (const cookie of body.cookies) {
      const d = cookie.domain.startsWith('.')
        ? cookie.domain.slice(1)
        : cookie.domain
      if (d) domainSet.add(d)
    }
    logger.info(
      {
        requestId,
        workspace_id: workspace.workspace_id,
        cookie_count: body.cookies.length,
        domain_count: domainSet.size,
        profile_label: body.profile_label,
      },
      'cookie-sync: upload received',
    )

    try {
      // 1. Resolve / create the workspace's Browserbase Context.
      const snapshot = await getContextSnapshot(workspace.workspace_id)
      let contextId = snapshot?.contextId ?? null
      if (!contextId) {
        const createCtx = await resolveCreateContext()
        const created = await createCtx()
        contextId = created.contextId
        await setWorkspaceContextId(workspace.workspace_id, contextId)
      }

      // 2. Boot a short-lived session pointed at the Context, inject via
      //    CDP, stop cleanly so the Context persists.
      const deps = await resolveSyncDeps()
      const result = await syncCookiesToContext(
        {
          workspaceId: workspace.workspace_id,
          contextId,
          cookies: body.cookies,
          ...(body.local_storage !== undefined
            ? { localStorage: body.local_storage }
            : {}),
          ...(body.domains !== undefined ? { domains: body.domains } : {}),
        },
        deps,
      )

      // 3. Bump the sync timestamp.
      const syncedAt = new Date()
      await markWorkspaceSynced(workspace.workspace_id, syncedAt)

      return c.json(
        {
          context_id: contextId,
          synced_at: syncedAt.toISOString(),
          cookie_count: result.injectedCookies,
          local_storage_count: result.injectedItems,
          domains: result.domains,
          // Compatibility aliases — desktop's CookieSyncResponseSchema today
          // reads `profileId` + `cookieCount`. Including both lets us flip
          // desktop's URL without touching its parser. (See
          // DESKTOP_INTEGRATION.md table line 277.)
          profileId: contextId,
          cookieCount: result.injectedCookies,
        },
        200,
      )
    } catch (err) {
      if (err instanceof BrowserbaseUnavailableError) {
        return c.json({ error: 'browserbase_unavailable' }, 503)
      }
      logger.error(
        {
          requestId,
          workspace_id: workspace.workspace_id,
          err: { message: (err as Error).message, name: (err as Error).name },
        },
        'cookie-sync: upload failed',
      )
      // Project all other failures (Browserbase 5xx, CDP error, DB write
      // failure) as 502 with a structured body — the route's contract
      // promised handleError-style consistency.
      return handleError(
        c,
        new InternalError(
          `cookie-sync: ${(err as Error).message ?? 'upstream failure'}`,
        ),
      )
    }
  },
)

/**
 * GET /v1/runtime/contexts/me — read the calling workspace's sync state.
 *
 * Returns 200 even when the workspace has never synced; callers
 * disambiguate via `context_id === null`. Mirrors agent/'s
 * `/v1/cookie-sync/status` shape so desktop's `getCookieSyncStatus` can
 * be repointed by URL flip alone.
 *
 * The path is `/me` rather than `/:workspace_id` because the JWT already
 * names the workspace — a path param would either be redundant (if it
 * matches the JWT) or a foot-gun (if it can be supplied independently).
 */
contextsRoute.get('/me', async (c) => {
  const workspace = c.get('workspace')
  try {
    const snap = await getContextSnapshot(workspace.workspace_id)
    return c.json(
      {
        context_id: snap?.contextId ?? null,
        last_synced_at: snap?.lastSyncedAt ?? null,
        has_sync: snap?.contextId !== null && snap?.contextId !== undefined,
        // Compatibility aliases for the desktop's CookieSyncStatusSchema.
        hasSync: snap?.contextId !== null && snap?.contextId !== undefined,
        lastSyncedAt: snap?.lastSyncedAt ?? null,
        profileId: snap?.contextId ?? null,
      },
      200,
    )
  } catch (err) {
    return handleError(c, err)
  }
})

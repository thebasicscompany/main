/**
 * Workspace context repo — Phase 07.
 *
 * Reads / writes the two `public.workspaces` columns runtime uses for
 * cookie sync:
 *   - `browserbase_profile_id` — the per-workspace Browserbase Context id
 *     (column name is historical; pre-Contexts agent/ stored Profile ids
 *     here, runtime stores Context ids in the same column).
 *   - `last_cookie_sync_at` — wall-clock timestamp of the last successful
 *     sync, surfaced to the desktop's "last synced X ago" status UI.
 *
 * Mirrors the `RunStateRepo` / `ApprovalRepo` pattern: memory + Drizzle
 * impls behind a module-level facade, NODE_ENV=test picks memory, tests
 * swap impls via `__setForTests`. The `public.workspaces` table is owned
 * by `agent/`; runtime declares only the columns it touches in
 * `db/workspaces.ts` (deliberately outside `db/schema.ts` — drizzle-kit
 * reads schema from `db/schema.ts`, so the workspaces binding is invisible
 * to migration generation and runtime can never propose ALTERs on the
 * agent-owned table).
 */

import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import { workspaces as workspacesTable } from '../db/workspaces.js'

export interface WorkspaceContextSnapshot {
  /** The workspace's Browserbase Context id, or null if never synced. */
  contextId: string | null
  /** ISO string of last successful sync, or null. */
  lastSyncedAt: string | null
}

export interface WorkspaceContextRepo {
  /**
   * Read the cookie-sync columns for a workspace. Returns null if the
   * workspace row doesn't exist.
   */
  getSnapshot(workspaceId: string): Promise<WorkspaceContextSnapshot | null>
  /**
   * Pin a Context id to the workspace row. Used after creating a fresh
   * Browserbase Context on first sync.
   */
  setContextId(workspaceId: string, contextId: string): Promise<void>
  /**
   * Bump the workspace's `last_cookie_sync_at` to the supplied timestamp.
   * Called at the end of a successful sync.
   */
  markSynced(workspaceId: string, syncedAt: Date): Promise<void>
}

// =============================================================================
// Memory impl — used by every test except the ones that explicitly target
// Drizzle.
// =============================================================================

export function createMemoryRepo(): WorkspaceContextRepo & {
  __reset: () => void
  __seed: (workspaceId: string, snap: WorkspaceContextSnapshot) => void
} {
  const store = new Map<string, WorkspaceContextSnapshot>()
  return {
    async getSnapshot(workspaceId) {
      return store.get(workspaceId) ?? null
    },
    async setContextId(workspaceId, contextId) {
      const cur = store.get(workspaceId) ?? {
        contextId: null,
        lastSyncedAt: null,
      }
      store.set(workspaceId, { ...cur, contextId })
    },
    async markSynced(workspaceId, syncedAt) {
      const cur = store.get(workspaceId) ?? {
        contextId: null,
        lastSyncedAt: null,
      }
      store.set(workspaceId, { ...cur, lastSyncedAt: syncedAt.toISOString() })
    },
    __reset() {
      store.clear()
    },
    __seed(workspaceId, snap) {
      store.set(workspaceId, snap)
    },
  }
}

// =============================================================================
// Drizzle impl — writes through to public.workspaces.
//
// `getSnapshot` returns null when no row matches the workspaceId. The
// route layer treats this as "workspace unknown / JWT issued for a deleted
// workspace" and surfaces 404. Writes use UPDATE rather than INSERT — the
// row is created by the auth/signup flow in `agent/`; runtime never owns
// row creation.
// =============================================================================

export function createDrizzleRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): WorkspaceContextRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)
  return {
    async getSnapshot(workspaceId) {
      const rows = await db()
        .select({
          browserbaseProfileId: workspacesTable.browserbaseProfileId,
          lastCookieSyncAt: workspacesTable.lastCookieSyncAt,
        })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, workspaceId))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return {
        contextId: row.browserbaseProfileId ?? null,
        lastSyncedAt: row.lastCookieSyncAt
          ? row.lastCookieSyncAt.toISOString()
          : null,
      }
    },
    async setContextId(workspaceId, contextId) {
      await db()
        .update(workspacesTable)
        .set({ browserbaseProfileId: contextId })
        .where(eq(workspacesTable.id, workspaceId))
    },
    async markSynced(workspaceId, syncedAt) {
      await db()
        .update(workspacesTable)
        .set({ lastCookieSyncAt: syncedAt })
        .where(eq(workspacesTable.id, workspaceId))
    },
  }
}

// =============================================================================
// Module-level facade. Memory impl under NODE_ENV=test, Drizzle elsewhere.
// =============================================================================

let activeRepo: WorkspaceContextRepo | null = null

function selectDefaultRepo(): WorkspaceContextRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRepo()
  return createDrizzleRepo()
}

function getRepo(): WorkspaceContextRepo {
  if (!activeRepo) activeRepo = selectDefaultRepo()
  return activeRepo
}

export async function getSnapshot(
  workspaceId: string,
): Promise<WorkspaceContextSnapshot | null> {
  return getRepo().getSnapshot(workspaceId)
}

export async function setContextId(
  workspaceId: string,
  contextId: string,
): Promise<void> {
  return getRepo().setContextId(workspaceId, contextId)
}

export async function markSynced(
  workspaceId: string,
  syncedAt: Date,
): Promise<void> {
  return getRepo().markSynced(workspaceId, syncedAt)
}

/** Test-only: install a specific repo for the duration of a test. */
export function __setWorkspaceContextRepoForTests(
  repo: WorkspaceContextRepo | null,
): void {
  activeRepo = repo
}

/** Test-only: drop in-memory state. */
export function __resetForTests(): void {
  if (activeRepo && '__reset' in activeRepo) {
    ;(activeRepo as { __reset: () => void }).__reset()
  } else {
    activeRepo = null
  }
}

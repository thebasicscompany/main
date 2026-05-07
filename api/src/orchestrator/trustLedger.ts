/**
 * Trust ledger — Phase 04B.
 *
 * Append-only grants that auto-approve gated tool calls when (a) the tool
 * name matches `action_pattern`, (b) the call's params satisfy
 * `params_constraint`, (c) the grant's `scope` covers the current
 * workflow, and (d) the grant is neither expired nor revoked.
 *
 * Match logic (v1 — kept narrow on purpose):
 *   - action_pattern: exact match OR `prefix.*` glob (single trailing star).
 *   - params_constraint: shallow equality. `{x: 100}` matches if and only if
 *     `params.x === 100`. Anything more sophisticated (jsonpath, `$in`,
 *     `$regex`, nested matches) is deferred to Phase 09 — see TODO below.
 *   - scope: 'workspace' (always matches the workspace) OR `workflow:<id>`
 *     (matches only when `workflowId === <id>`).
 *
 * TODO(Phase 09): richer params_constraint vocabulary — `$in`, `$regex`,
 * jsonpath segments, `$gt/$lt` for numerics, nested object equality.
 */

import { and, desc, eq, isNull, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import { trustGrants as trustGrantsTable, type TrustGrant } from '../db/schema.js'

export interface TrustGrantRecord {
  id: string
  workspaceId: string
  grantedBy: string
  actionPattern: string
  paramsConstraint: Record<string, unknown>
  scope: string
  expiresAt: string | null
  revokedAt: string | null
  revokedBy: string | null
  createdAt: string
}

export interface CreateTrustGrantInput {
  workspaceId: string
  grantedBy: string
  actionPattern: string
  paramsConstraint?: Record<string, unknown>
  scope: string
  expiresAt?: Date | null
}

export interface FindMatchingInput {
  workspaceId: string
  toolName: string
  params: Record<string, unknown>
  workflowId?: string
}

/**
 * Filter shape for `TrustGrantRepo.list`. Phase 09 surfaces these via the
 * `/v1/runtime/trust-grants` route; the route layer derives `workspaceId`
 * from the JWT, the rest are optional.
 */
export interface ListTrustGrantsInput {
  workspaceId: string
  /** Exact match (the `action_pattern` text is what was stored — no glob expansion here). */
  actionPattern?: string
  /** Default false: drop expired grants from the result. Revoked grants are
   *  always included so the UI can show a revoked-history view; callers
   *  that want only active grants should filter by `revokedAt === null`. */
  includeExpired?: boolean
  limit?: number
  offset?: number
}

export interface TrustGrantRepo {
  create(input: CreateTrustGrantInput): Promise<TrustGrantRecord>
  findMatching(input: FindMatchingInput): Promise<TrustGrantRecord | null>
  revoke(grantId: string, revokedBy: string): Promise<void>
  /** Phase 09: list workspace's grants, newest first. */
  list(input: ListTrustGrantsInput): Promise<TrustGrantRecord[]>
  /** Phase 09: fetch one grant by id, scoped by workspace. Returns null if missing or owned by another workspace. */
  get(workspaceId: string, grantId: string): Promise<TrustGrantRecord | null>
}

// =============================================================================
// Match helpers (shared by both impls).
// =============================================================================

/**
 * `pattern` matches `toolName` if either (a) they're equal, or (b) the
 * pattern ends with `.*` and `toolName` starts with `pattern.slice(0, -1)`.
 * No mid-string wildcards in v1 — keeps the intent obvious.
 */
export function matchActionPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1) // keep trailing '.'
    return toolName.startsWith(prefix)
  }
  // Bare '*' is also a fully-permissive grant.
  if (pattern === '*') return true
  return false
}

/**
 * Shallow equality check. Every key in the constraint must appear in
 * `params` with a strictly equal value. Empty constraint matches anything.
 */
export function matchParamsConstraint(
  constraint: Record<string, unknown>,
  params: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(constraint)) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return false
    if (params[key] !== expected) return false
  }
  return true
}

/**
 * `scope` matches if it's literally 'workspace' or matches the
 * `workflow:<id>` shape with the current workflow id. Unknown scope
 * strings are treated as non-matching (safer default).
 */
export function matchScope(scope: string, workflowId?: string): boolean {
  if (scope === 'workspace') return true
  if (scope.startsWith('workflow:')) {
    const want = scope.slice('workflow:'.length)
    return workflowId !== undefined && want === workflowId
  }
  return false
}

function isActiveAt(rec: TrustGrantRecord, when: Date): boolean {
  if (rec.revokedAt !== null) return false
  if (rec.expiresAt !== null && new Date(rec.expiresAt).getTime() <= when.getTime()) {
    return false
  }
  return true
}

export function grantMatches(
  rec: TrustGrantRecord,
  input: FindMatchingInput,
  now: Date = new Date(),
): boolean {
  if (rec.workspaceId !== input.workspaceId) return false
  if (!isActiveAt(rec, now)) return false
  if (!matchActionPattern(rec.actionPattern, input.toolName)) return false
  if (!matchScope(rec.scope, input.workflowId)) return false
  if (!matchParamsConstraint(rec.paramsConstraint, input.params)) return false
  return true
}

// =============================================================================
// Memory impl.
// =============================================================================

export function createMemoryRepo(): TrustGrantRepo & {
  __reset: () => void
  __all: () => TrustGrantRecord[]
} {
  const store = new Map<string, TrustGrantRecord>()
  let counter = 0
  return {
    async create(input) {
      counter++
      const id = `grant-${counter}-${Math.random().toString(36).slice(2, 8)}`
      const rec: TrustGrantRecord = {
        id,
        workspaceId: input.workspaceId,
        grantedBy: input.grantedBy,
        actionPattern: input.actionPattern,
        paramsConstraint: input.paramsConstraint ?? {},
        scope: input.scope,
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
        revokedAt: null,
        revokedBy: null,
        createdAt: new Date().toISOString(),
      }
      store.set(id, rec)
      return rec
    },
    async findMatching(input) {
      const now = new Date()
      for (const rec of store.values()) {
        if (grantMatches(rec, input, now)) return rec
      }
      return null
    },
    async revoke(grantId, revokedBy) {
      const cur = store.get(grantId)
      if (!cur) return
      store.set(grantId, {
        ...cur,
        revokedAt: new Date().toISOString(),
        revokedBy,
      })
    },
    async list(input) {
      const now = Date.now()
      const all = [...store.values()].filter((rec) => {
        if (rec.workspaceId !== input.workspaceId) return false
        if (
          input.actionPattern !== undefined &&
          rec.actionPattern !== input.actionPattern
        )
          return false
        if (
          !(input.includeExpired ?? false) &&
          rec.expiresAt !== null &&
          new Date(rec.expiresAt).getTime() <= now
        )
          return false
        return true
      })
      // Newest first by createdAt.
      all.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      const start = input.offset ?? 0
      const end = input.limit !== undefined ? start + input.limit : undefined
      return all.slice(start, end)
    },
    async get(workspaceId, grantId) {
      const rec = store.get(grantId)
      if (!rec) return null
      if (rec.workspaceId !== workspaceId) return null
      return rec
    },
    __reset() {
      store.clear()
      counter = 0
    },
    __all() {
      return [...store.values()]
    },
  }
}

// =============================================================================
// Drizzle impl.
// =============================================================================

function rowToRecord(row: TrustGrant): TrustGrantRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    grantedBy: row.grantedBy,
    actionPattern: row.actionPattern,
    paramsConstraint: (row.paramsConstraint ?? {}) as Record<string, unknown>,
    scope: row.scope,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedBy: row.revokedBy ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export function createDrizzleRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): TrustGrantRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async create(input) {
      const rows = await db()
        .insert(trustGrantsTable)
        .values({
          workspaceId: input.workspaceId,
          grantedBy: input.grantedBy,
          actionPattern: input.actionPattern,
          paramsConstraint: input.paramsConstraint ?? {},
          scope: input.scope,
          expiresAt: input.expiresAt ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('trustGrants insert returned no row')
      return rowToRecord(row)
    },
    async findMatching(input) {
      // Server-side: filter by (workspace_id, revoked_at IS NULL) — covered
      // by the (workspace_id, action_pattern) index. The remaining checks
      // (action pattern glob, params equality, scope, expiry) run in
      // application code so the v1 vocabulary stays simple. Volume per
      // workspace is small (handful of grants per design partner), so
      // scanning is fine until Phase 09 lifts richer matchers into SQL.
      const rows = await db()
        .select()
        .from(trustGrantsTable)
        .where(
          and(
            eq(trustGrantsTable.workspaceId, input.workspaceId),
            isNull(trustGrantsTable.revokedAt),
          ),
        )
      const now = new Date()
      for (const row of rows) {
        const rec = rowToRecord(row)
        if (grantMatches(rec, input, now)) return rec
      }
      return null
    },
    async revoke(grantId, revokedBy) {
      await db()
        .update(trustGrantsTable)
        .set({ revokedAt: new Date(), revokedBy })
        .where(eq(trustGrantsTable.id, grantId))
    },
    async list(input) {
      const filters: SQL[] = [
        eq(trustGrantsTable.workspaceId, input.workspaceId),
      ]
      if (input.actionPattern !== undefined) {
        filters.push(eq(trustGrantsTable.actionPattern, input.actionPattern))
      }
      // Expiry filtering happens in application code so the SQL stays
      // simple — the volume per workspace is small (handful of grants per
      // design partner per the v1 sizing assumption in `findMatching`).
      let q = db()
        .select()
        .from(trustGrantsTable)
        .where(and(...filters))
        .orderBy(desc(trustGrantsTable.createdAt)) as unknown as {
        limit: (n: number) => unknown
        offset: (n: number) => unknown
      }
      if (input.limit !== undefined) q = q.limit(input.limit) as typeof q
      if (input.offset !== undefined) q = q.offset(input.offset) as typeof q
      const rows = (await (q as unknown as Promise<TrustGrant[]>)) as TrustGrant[]
      const now = Date.now()
      const records = rows.map(rowToRecord)
      if (input.includeExpired ?? false) return records
      return records.filter((rec) => {
        if (rec.expiresAt === null) return true
        return new Date(rec.expiresAt).getTime() > now
      })
    },
    async get(workspaceId, grantId) {
      const rows = await db()
        .select()
        .from(trustGrantsTable)
        .where(eq(trustGrantsTable.id, grantId))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      const rec = rowToRecord(row)
      if (rec.workspaceId !== workspaceId) return null
      return rec
    },
  }
}

// =============================================================================
// Module-level facade.
// =============================================================================

let activeRepo: TrustGrantRepo | null = null

function selectDefaultRepo(): TrustGrantRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRepo()
  return createDrizzleRepo()
}

function getRepo(): TrustGrantRepo {
  if (!activeRepo) activeRepo = selectDefaultRepo()
  return activeRepo
}

export function create(
  input: CreateTrustGrantInput,
): Promise<TrustGrantRecord> {
  return getRepo().create(input)
}

export function findMatching(
  input: FindMatchingInput,
): Promise<TrustGrantRecord | null> {
  return getRepo().findMatching(input)
}

export function revoke(grantId: string, revokedBy: string): Promise<void> {
  return getRepo().revoke(grantId, revokedBy)
}

export function list(
  input: ListTrustGrantsInput,
): Promise<TrustGrantRecord[]> {
  return getRepo().list(input)
}

export function get(
  workspaceId: string,
  grantId: string,
): Promise<TrustGrantRecord | null> {
  return getRepo().get(workspaceId, grantId)
}

/** Test-only: install a specific repo. */
export function __setTrustGrantRepoForTests(
  repo: TrustGrantRepo | null,
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

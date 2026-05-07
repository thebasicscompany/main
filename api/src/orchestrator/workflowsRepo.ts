/**
 * Workflows repository — Phase 10.
 *
 * Mirrors the `RunStateRepo` / `ApprovalRepo` pattern: pluggable backing
 * store with a memory impl for tests and a Drizzle impl for production.
 * Backed by `runtime.runtime_workflows`.
 *
 * Each row is a per-workspace playbook definition: name, LLM prompt,
 * optional cron `schedule`, declarative `checkModules`, and a free-form
 * `requiredCredentials` jsonb.
 *
 * The orchestrator's two built-in workflow IDs (`hello-world`,
 * `agent-helloworld`) are NOT stored here — they're resolved by name
 * before any DB lookup. Anything else is matched by UUID.
 */

import { and, desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import { workflows as workflowsTable, type Workflow } from '../db/schema.js'

/**
 * Phase 11: each entry on a workflow's check schedule is `{ name, params }`.
 * `name` keys into `api/src/checks/registry.ts`; `params` is the
 * free-form object that primitive interprets.
 */
export interface CheckModuleEntry {
  name: string
  params: Record<string, unknown>
}

export interface WorkflowRecord {
  id: string
  workspaceId: string
  name: string
  prompt: string
  schedule: string | null
  requiredCredentials: Record<string, unknown>
  checkModules: CheckModuleEntry[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateWorkflowInput {
  workspaceId: string
  name: string
  prompt: string
  schedule?: string | null
  requiredCredentials?: Record<string, unknown>
  checkModules?: CheckModuleEntry[]
  enabled?: boolean
}

export interface UpdateWorkflowInput {
  name?: string
  prompt?: string
  schedule?: string | null
  requiredCredentials?: Record<string, unknown>
  checkModules?: CheckModuleEntry[]
  enabled?: boolean
}

export interface ListWorkflowsInput {
  workspaceId: string
  enabled?: boolean
  limit?: number
  offset?: number
}

export interface WorkflowsRepo {
  list(input: ListWorkflowsInput): Promise<WorkflowRecord[]>
  get(workspaceId: string, workflowId: string): Promise<WorkflowRecord | null>
  /**
   * Look up a workflow by id ONLY (no workspace scoping). Phase 10.5 —
   * the cron-fired /run-now path doesn't have a workspace JWT, so it
   * resolves the workspace from the row itself. Treat this as
   * server-only: never expose to user-facing endpoints.
   */
  getById(workflowId: string): Promise<WorkflowRecord | null>
  create(input: CreateWorkflowInput): Promise<WorkflowRecord>
  update(
    workspaceId: string,
    workflowId: string,
    patch: UpdateWorkflowInput,
  ): Promise<WorkflowRecord | null>
  delete(
    workspaceId: string,
    workflowId: string,
  ): Promise<{ deleted: boolean }>
}

// =============================================================================
// Memory impl — used in tests.
// =============================================================================

function isUuidLike(s: string): boolean {
  // Accept any non-empty string in the memory impl. The Drizzle impl will
  // hand the value to Postgres which performs strict UUID validation; the
  // route layer normalizes shapes before that.
  return s.length > 0
}

let memoryCounter = 0

export function createMemoryRepo(): WorkflowsRepo & { __reset: () => void } {
  const store = new Map<string, WorkflowRecord>()
  return {
    async list(input) {
      const all = [...store.values()].filter((w) => {
        if (w.workspaceId !== input.workspaceId) return false
        if (input.enabled !== undefined && w.enabled !== input.enabled)
          return false
        return true
      })
      // Newest first, mirroring the runs repo + the route's "recently
      // created at the top" UX expectation.
      all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const start = input.offset ?? 0
      const end = input.limit !== undefined ? start + input.limit : undefined
      return all.slice(start, end)
    },
    async get(workspaceId, workflowId) {
      const w = store.get(workflowId)
      if (!w) return null
      if (w.workspaceId !== workspaceId) return null
      return w
    },
    async getById(workflowId) {
      return store.get(workflowId) ?? null
    },
    async create(input) {
      memoryCounter++
      const id = `wf-${memoryCounter}-${Math.random().toString(36).slice(2, 8)}`
      const now = new Date().toISOString()
      const rec: WorkflowRecord = {
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule ?? null,
        requiredCredentials: input.requiredCredentials ?? {},
        checkModules: input.checkModules ?? [],
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      }
      store.set(id, rec)
      return rec
    },
    async update(workspaceId, workflowId, patch) {
      const cur = store.get(workflowId)
      if (!cur) return null
      if (cur.workspaceId !== workspaceId) return null
      const next: WorkflowRecord = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.requiredCredentials !== undefined
          ? { requiredCredentials: patch.requiredCredentials }
          : {}),
        ...(patch.checkModules !== undefined
          ? { checkModules: patch.checkModules }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: new Date().toISOString(),
      }
      store.set(workflowId, next)
      return next
    },
    async delete(workspaceId, workflowId) {
      const cur = store.get(workflowId)
      if (!cur) return { deleted: false }
      if (cur.workspaceId !== workspaceId) return { deleted: false }
      store.delete(workflowId)
      return { deleted: true }
    },
    __reset() {
      store.clear()
      memoryCounter = 0
    },
  }
}

// =============================================================================
// Drizzle impl — runtime.runtime_workflows.
// =============================================================================

function rowToRecord(row: Workflow): WorkflowRecord {
  // Defensive: legacy rows (pre-Phase 11) might still hold the old
  // `string[]` shape if a migration partially applied. Normalize so the
  // rest of the runtime always sees `{ name, params }[]`.
  const rawModules = row.checkModules as unknown
  let checkModules: CheckModuleEntry[]
  if (Array.isArray(rawModules)) {
    checkModules = rawModules.map((entry) => {
      if (typeof entry === 'string') {
        return { name: entry, params: {} }
      }
      if (entry && typeof entry === 'object') {
        const o = entry as Record<string, unknown>
        const name = typeof o.name === 'string' ? o.name : ''
        const params =
          o.params && typeof o.params === 'object' && !Array.isArray(o.params)
            ? (o.params as Record<string, unknown>)
            : {}
        return { name, params }
      }
      return { name: '', params: {} }
    })
  } else {
    checkModules = []
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule ?? null,
    requiredCredentials:
      (row.requiredCredentials ?? {}) as Record<string, unknown>,
    checkModules,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function createDrizzleRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): WorkflowsRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async list(input) {
      const filters = [eq(workflowsTable.workspaceId, input.workspaceId)]
      if (input.enabled !== undefined) {
        filters.push(eq(workflowsTable.enabled, input.enabled))
      }
      let q = db()
        .select()
        .from(workflowsTable)
        .where(and(...filters))
        .orderBy(desc(workflowsTable.createdAt)) as unknown as {
        limit: (n: number) => unknown
        offset: (n: number) => unknown
      }
      if (input.limit !== undefined) q = q.limit(input.limit) as typeof q
      if (input.offset !== undefined) q = q.offset(input.offset) as typeof q
      const rows = (await (q as unknown as Promise<Workflow[]>)) as Workflow[]
      return rows.map(rowToRecord)
    },
    async get(workspaceId, workflowId) {
      // Strict UUID-ish guard before hitting Postgres — the column is
      // typed `uuid` and a malformed input throws a 22P02 server-side.
      // Treat malformed ids as "not found" so the route layer can return
      // 404 cleanly.
      if (!isUuidLike(workflowId)) return null
      const rows = await db()
        .select()
        .from(workflowsTable)
        .where(
          and(
            eq(workflowsTable.id, workflowId),
            eq(workflowsTable.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? rowToRecord(row) : null
    },
    async getById(workflowId) {
      if (!isUuidLike(workflowId)) return null
      const rows = await db()
        .select()
        .from(workflowsTable)
        .where(eq(workflowsTable.id, workflowId))
        .limit(1)
      const row = rows[0]
      return row ? rowToRecord(row) : null
    },
    async create(input) {
      const rows = await db()
        .insert(workflowsTable)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule ?? null,
          requiredCredentials:
            (input.requiredCredentials ?? {}) as never,
          checkModules: (input.checkModules ?? []) as never,
          enabled: input.enabled ?? true,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('workflows insert returned no row')
      return rowToRecord(row)
    },
    async update(workspaceId, workflowId, patch) {
      if (!isUuidLike(workflowId)) return null
      const set: Partial<typeof workflowsTable.$inferInsert> = {
        updatedAt: new Date(),
      }
      if (patch.name !== undefined) set.name = patch.name
      if (patch.prompt !== undefined) set.prompt = patch.prompt
      if (patch.schedule !== undefined) set.schedule = patch.schedule
      if (patch.requiredCredentials !== undefined) {
        set.requiredCredentials = patch.requiredCredentials as never
      }
      if (patch.checkModules !== undefined) {
        set.checkModules = patch.checkModules as never
      }
      if (patch.enabled !== undefined) set.enabled = patch.enabled

      const rows = await db()
        .update(workflowsTable)
        .set(set)
        .where(
          and(
            eq(workflowsTable.id, workflowId),
            eq(workflowsTable.workspaceId, workspaceId),
          ),
        )
        .returning()
      const row = rows[0]
      return row ? rowToRecord(row) : null
    },
    async delete(workspaceId, workflowId) {
      if (!isUuidLike(workflowId)) return { deleted: false }
      const rows = await db()
        .delete(workflowsTable)
        .where(
          and(
            eq(workflowsTable.id, workflowId),
            eq(workflowsTable.workspaceId, workspaceId),
          ),
        )
        .returning({ id: workflowsTable.id })
      return { deleted: rows.length > 0 }
    },
  }
}

// =============================================================================
// Module-level facade. Memory impl under NODE_ENV=test, Drizzle elsewhere.
// =============================================================================

let activeRepo: WorkflowsRepo | null = null

function selectDefaultRepo(): WorkflowsRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRepo()
  return createDrizzleRepo()
}

function getRepo(): WorkflowsRepo {
  if (!activeRepo) activeRepo = selectDefaultRepo()
  return activeRepo
}

export function list(input: ListWorkflowsInput): Promise<WorkflowRecord[]> {
  return getRepo().list(input)
}

export function get(
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowRecord | null> {
  return getRepo().get(workspaceId, workflowId)
}

/**
 * Server-only lookup by id without workspace scoping. Used by the
 * cron-triggered run-now path (Phase 10.5) where there's no workspace
 * JWT to scope the query — the row itself supplies workspace_id. Do
 * NOT call from any user-facing endpoint.
 */
export function getById(
  workflowId: string,
): Promise<WorkflowRecord | null> {
  return getRepo().getById(workflowId)
}

export function create(input: CreateWorkflowInput): Promise<WorkflowRecord> {
  return getRepo().create(input)
}

export function update(
  workspaceId: string,
  workflowId: string,
  patch: UpdateWorkflowInput,
): Promise<WorkflowRecord | null> {
  return getRepo().update(workspaceId, workflowId, patch)
}

export function remove(
  workspaceId: string,
  workflowId: string,
): Promise<{ deleted: boolean }> {
  return getRepo().delete(workspaceId, workflowId)
}

/** Test-only: install a specific repo for the duration of a test. */
export function __setWorkflowsRepoForTests(repo: WorkflowsRepo | null): void {
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

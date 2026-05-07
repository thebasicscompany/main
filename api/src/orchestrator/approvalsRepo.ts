/**
 * Approvals repository — Phase 04B.
 *
 * Mirrors the `RunStateRepo` pattern (memory + Drizzle impls behind a
 * module-level facade). Backed by `runtime.runtime_approvals`.
 *
 * Status lifecycle: `pending` → `approved | rejected | timeout`. Once
 * leaving `pending`, the row is terminal — `resolve` on a non-pending row
 * throws `ApprovalAlreadyResolvedError` so the route handler can return
 * 409.
 */

import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import { approvals as approvalsTable, type Approval } from '../db/schema.js'
import { AppError } from '../lib/errors.js'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout'
export type ApprovalResolvedVia = 'overlay' | 'slack' | 'system'

export interface ApprovalRecord {
  id: string
  runId: string
  workspaceId: string
  toolName: string
  params: Record<string, unknown>
  status: ApprovalStatus
  resolvedBy: string | null
  resolvedAt: string | null
  resolvedVia: ApprovalResolvedVia | null
  remember: boolean
  expiresAt: string
  createdAt: string
}

export interface CreateApprovalInput {
  runId: string
  workspaceId: string
  toolName: string
  params: Record<string, unknown>
  expiresAt: Date
}

export interface ResolveApprovalInput {
  decision: 'approve' | 'reject' | 'timeout'
  resolvedBy?: string | null
  resolvedVia: ApprovalResolvedVia
  remember?: boolean
}

export class ApprovalNotFoundError extends AppError {
  constructor(message = 'Approval not found') {
    super(404, 'approval_not_found', message)
    this.name = 'ApprovalNotFoundError'
  }
}

export class ApprovalAlreadyResolvedError extends AppError {
  readonly currentStatus: ApprovalStatus
  constructor(currentStatus: ApprovalStatus) {
    super(409, 'approval_already_resolved', `Approval already ${currentStatus}`)
    this.name = 'ApprovalAlreadyResolvedError'
    this.currentStatus = currentStatus
  }
}

export interface ApprovalRepo {
  create(input: CreateApprovalInput): Promise<ApprovalRecord>
  get(approvalId: string): Promise<ApprovalRecord | null>
  resolve(
    approvalId: string,
    input: ResolveApprovalInput,
  ): Promise<ApprovalRecord>
  listPending(runId: string): Promise<ApprovalRecord[]>
}

// =============================================================================
// Memory impl — used in tests.
// =============================================================================

function decisionToStatus(
  d: ResolveApprovalInput['decision'],
): ApprovalStatus {
  if (d === 'approve') return 'approved'
  if (d === 'reject') return 'rejected'
  return 'timeout'
}

export function createMemoryRepo(): ApprovalRepo & { __reset: () => void } {
  const store = new Map<string, ApprovalRecord>()
  let counter = 0
  return {
    async create(input) {
      counter++
      const id = `appr-${counter}-${Math.random().toString(36).slice(2, 8)}`
      const now = new Date().toISOString()
      const rec: ApprovalRecord = {
        id,
        runId: input.runId,
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        params: input.params,
        status: 'pending',
        resolvedBy: null,
        resolvedAt: null,
        resolvedVia: null,
        remember: false,
        expiresAt: input.expiresAt.toISOString(),
        createdAt: now,
      }
      store.set(id, rec)
      return rec
    },
    async get(approvalId) {
      return store.get(approvalId) ?? null
    },
    async resolve(approvalId, input) {
      const cur = store.get(approvalId)
      if (!cur) throw new ApprovalNotFoundError()
      if (cur.status !== 'pending') {
        throw new ApprovalAlreadyResolvedError(cur.status)
      }
      const next: ApprovalRecord = {
        ...cur,
        status: decisionToStatus(input.decision),
        resolvedBy: input.resolvedBy ?? null,
        resolvedAt: new Date().toISOString(),
        resolvedVia: input.resolvedVia,
        remember: input.remember ?? false,
      }
      store.set(approvalId, next)
      return next
    },
    async listPending(runId) {
      return [...store.values()].filter(
        (a) => a.runId === runId && a.status === 'pending',
      )
    },
    __reset() {
      store.clear()
      counter = 0
    },
  }
}

// =============================================================================
// Drizzle impl — runtime.runtime_approvals.
// =============================================================================

function rowToRecord(row: Approval): ApprovalRecord {
  return {
    id: row.id,
    runId: row.runId,
    workspaceId: row.workspaceId,
    toolName: row.toolName,
    params: (row.params ?? {}) as Record<string, unknown>,
    status: row.status as ApprovalStatus,
    resolvedBy: row.resolvedBy ?? null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedVia: (row.resolvedVia as ApprovalResolvedVia | null) ?? null,
    remember: row.remember,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

export function createDrizzleRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): ApprovalRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async create(input) {
      const rows = await db()
        .insert(approvalsTable)
        .values({
          runId: input.runId,
          workspaceId: input.workspaceId,
          toolName: input.toolName,
          params: input.params,
          status: 'pending',
          remember: false,
          expiresAt: input.expiresAt,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('approvals insert returned no row')
      return rowToRecord(row)
    },
    async get(approvalId) {
      const rows = await db()
        .select()
        .from(approvalsTable)
        .where(eq(approvalsTable.id, approvalId))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return rowToRecord(row)
    },
    async resolve(approvalId, input) {
      // Atomic: only update if currently pending. If zero rows match, the
      // approval is either gone or already resolved — disambiguate with a
      // separate read so the caller gets the right error class.
      const rows = await db()
        .update(approvalsTable)
        .set({
          status: decisionToStatus(input.decision),
          resolvedBy: input.resolvedBy ?? null,
          resolvedAt: new Date(),
          resolvedVia: input.resolvedVia,
          remember: input.remember ?? false,
        })
        .where(
          and(
            eq(approvalsTable.id, approvalId),
            eq(approvalsTable.status, 'pending'),
          ),
        )
        .returning()
      const row = rows[0]
      if (row) return rowToRecord(row)

      const existing = await this.get(approvalId)
      if (!existing) throw new ApprovalNotFoundError()
      throw new ApprovalAlreadyResolvedError(existing.status)
    },
    async listPending(runId) {
      const rows = await db()
        .select()
        .from(approvalsTable)
        .where(
          and(
            eq(approvalsTable.runId, runId),
            eq(approvalsTable.status, 'pending'),
          ),
        )
      return rows.map(rowToRecord)
    },
  }
}

// =============================================================================
// Module-level facade. Memory impl under NODE_ENV=test, Drizzle elsewhere.
// =============================================================================

let activeRepo: ApprovalRepo | null = null

function selectDefaultRepo(): ApprovalRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRepo()
  return createDrizzleRepo()
}

function getRepo(): ApprovalRepo {
  if (!activeRepo) activeRepo = selectDefaultRepo()
  return activeRepo
}

export function create(input: CreateApprovalInput): Promise<ApprovalRecord> {
  return getRepo().create(input)
}

export function get(approvalId: string): Promise<ApprovalRecord | null> {
  return getRepo().get(approvalId)
}

export function resolve(
  approvalId: string,
  input: ResolveApprovalInput,
): Promise<ApprovalRecord> {
  return getRepo().resolve(approvalId, input)
}

export function listPending(runId: string): Promise<ApprovalRecord[]> {
  return getRepo().listPending(runId)
}

/** Test-only: install a specific repo for the duration of a test. */
export function __setApprovalRepoForTests(repo: ApprovalRepo | null): void {
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

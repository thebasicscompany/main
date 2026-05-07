/**
 * Check results repository — Phase 06.
 *
 * Mirrors the `RunStateRepo` pattern: pluggable backing store with a
 * memory impl for tests and a Drizzle impl for production. Backed by
 * `runtime.runtime_check_results`.
 *
 * One row per check invocation. The `checkRunner` writes via `record`;
 * read paths (e.g. dashboard, audit endpoints) call `listForRun`.
 */

import { asc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import {
  checkResults as checkResultsTable,
  type CheckResult as CheckResultRow,
} from '../db/schema.js'

export interface CheckResultRecord {
  id: string
  runId: string
  checkName: string
  passed: boolean
  evidence: unknown
  ranAt: string
}

export interface RecordCheckResultInput {
  runId: string
  checkName: string
  passed: boolean
  evidence: unknown
}

export interface CheckResultsRepo {
  record(input: RecordCheckResultInput): Promise<CheckResultRecord>
  listForRun(runId: string): Promise<CheckResultRecord[]>
}

// =============================================================================
// Memory impl — tests.
// =============================================================================

export function createMemoryRepo(): CheckResultsRepo & {
  __reset: () => void
} {
  const store = new Map<string, CheckResultRecord>()
  let counter = 0
  return {
    async record(input) {
      counter++
      const id = `chk-${counter}-${Math.random().toString(36).slice(2, 8)}`
      const rec: CheckResultRecord = {
        id,
        runId: input.runId,
        checkName: input.checkName,
        passed: input.passed,
        evidence: input.evidence,
        ranAt: new Date().toISOString(),
      }
      store.set(id, rec)
      return rec
    },
    async listForRun(runId) {
      return [...store.values()]
        .filter((r) => r.runId === runId)
        .sort((a, b) => a.ranAt.localeCompare(b.ranAt))
    },
    __reset() {
      store.clear()
      counter = 0
    },
  }
}

// =============================================================================
// Drizzle impl — runtime.runtime_check_results.
// =============================================================================

function rowToRecord(row: CheckResultRow): CheckResultRecord {
  return {
    id: row.id,
    runId: row.runId,
    checkName: row.checkName,
    passed: row.passed,
    evidence: row.evidence ?? null,
    ranAt: row.ranAt.toISOString(),
  }
}

export function createDrizzleRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): CheckResultsRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async record(input) {
      const rows = await db()
        .insert(checkResultsTable)
        .values({
          runId: input.runId,
          checkName: input.checkName,
          passed: input.passed,
          // jsonb column accepts undefined → NULL; force null for clarity.
          evidence:
            input.evidence === undefined
              ? null
              : (input.evidence as never),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('check_results insert returned no row')
      return rowToRecord(row)
    },
    async listForRun(runId) {
      const rows = await db()
        .select()
        .from(checkResultsTable)
        .where(eq(checkResultsTable.runId, runId))
        .orderBy(asc(checkResultsTable.ranAt))
      return rows.map(rowToRecord)
    },
  }
}

// =============================================================================
// Module-level facade — memory impl under NODE_ENV=test, Drizzle elsewhere.
// =============================================================================

let activeRepo: CheckResultsRepo | null = null

function selectDefaultRepo(): CheckResultsRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRepo()
  return createDrizzleRepo()
}

function getRepo(): CheckResultsRepo {
  if (!activeRepo) activeRepo = selectDefaultRepo()
  return activeRepo
}

export function record(
  input: RecordCheckResultInput,
): Promise<CheckResultRecord> {
  return getRepo().record(input)
}

export function listForRun(runId: string): Promise<CheckResultRecord[]> {
  return getRepo().listForRun(runId)
}

/** Test-only: install a specific repo for the duration of a test. */
export function __setCheckResultsRepoForTests(
  repo: CheckResultsRepo | null,
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

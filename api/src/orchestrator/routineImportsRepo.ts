import { randomUUID } from 'node:crypto'

/**
 * Routine import + workflow version persistence (Basics Cloud M1).
 *
 * Memory impl under NODE_ENV=test (matches workflowsRepo). Drizzle impl
 * otherwise. Promote creates a `runtime_workflows` row and version `1` in
 * `runtime_workflow_versions` in one transaction on Postgres.
 */

import { and, eq, max } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import {
  routineArtifacts as routineArtifactsTable,
  routineImports as routineImportsTable,
  workflowVersions as workflowVersionsTable,
  workflows as workflowsTable,
} from '../db/schema.js'
import type { CheckModuleEntry } from './workflowsRepo.js'
import * as workflowsRepo from './workflowsRepo.js'

export type RoutineImportStatus = 'importing' | 'imported' | 'failed'

export interface RoutineImportRecord {
  id: string
  workspaceId: string
  assistantRoutineId: string
  sourceAssistantId: string | null
  lensSessionId: string | null
  extensionRecordingId: string | null
  workflowId: string | null
  status: RoutineImportStatus
  error: string | null
  createdAt: Date
  updatedAt: Date
}

export interface RoutineArtifactRecord {
  id: string
  workspaceId: string
  importId: string
  workflowId: string | null
  kind: string
  storageUrl: string | null
  inlineJson: unknown | null
  contentType: string | null
  sizeBytes: number | null
  retentionExpiresAt: Date | null
  createdAt: Date
}

export interface CreateRoutineImportInput {
  workspaceId: string
  assistantRoutineId: string
  sourceAssistantId?: string
  lensSessionId?: string
  extensionRecordingId?: string
  artifacts: Array<{
    kind: string
    storageUrl?: string | null
    inlineJson?: unknown | null
    contentType?: string | null
    sizeBytes?: number | null
  }>
}

export interface InsertArtifactInput {
  workspaceId: string
  importId: string
  kind: string
  storageUrl?: string | null
  inlineJson?: unknown | null
  contentType?: string | null
  sizeBytes?: number | null
}

export interface PromoteRoutineImportInput {
  workspaceId: string
  importId: string
  accountId: string
  name: string
  prompt: string
  steps: unknown[]
  parameters: unknown[]
  checks: unknown[]
}

export interface PromoteRoutineImportResult {
  importId: string
  workflowId: string
  version: number
  status: 'imported'
}

export interface RoutineImportsRepo {
  findByWorkspaceAndAssistantRoutineId(
    workspaceId: string,
    assistantRoutineId: string,
  ): Promise<RoutineImportRecord | null>
  createWithArtifacts(input: CreateRoutineImportInput): Promise<RoutineImportRecord>
  getById(workspaceId: string, id: string): Promise<RoutineImportRecord | null>
  listArtifacts(workspaceId: string, importId: string): Promise<RoutineArtifactRecord[]>
  insertArtifact(input: InsertArtifactInput): Promise<RoutineArtifactRecord>
  promote(input: PromoteRoutineImportInput): Promise<PromoteRoutineImportResult>
}

export function checksToCheckModules(checks: unknown[]): CheckModuleEntry[] {
  const out: CheckModuleEntry[] = []
  for (const c of checks) {
    if (c && typeof c === 'object' && !Array.isArray(c) && 'name' in c) {
      const o = c as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name : ''
      const params =
        o.params &&
        typeof o.params === 'object' &&
        !Array.isArray(o.params)
          ? (o.params as Record<string, unknown>)
          : {}
      out.push({ name, params })
    }
  }
  return out
}

// =============================================================================
// Memory impl
// =============================================================================

function memRow(
  r: Omit<RoutineImportRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: Date
    updatedAt?: Date
  },
): RoutineImportRecord {
  const now = new Date()
  return {
    ...r,
    createdAt: r.createdAt ?? now,
    updatedAt: r.updatedAt ?? now,
  }
}

export function createMemoryRoutineImportsRepo(): RoutineImportsRepo & {
  __reset: () => void
} {
  const imports = new Map<string, RoutineImportRecord>()
  const artifactsByImport = new Map<string, RoutineArtifactRecord[]>()
  const versionByWorkflow = new Map<string, number>()

  return {
    __reset() {
      imports.clear()
      artifactsByImport.clear()
      versionByWorkflow.clear()
    },
    async findByWorkspaceAndAssistantRoutineId(workspaceId, assistantRoutineId) {
      for (const row of imports.values()) {
        if (
          row.workspaceId === workspaceId &&
          row.assistantRoutineId === assistantRoutineId
        ) {
          return row
        }
      }
      return null
    },
    async createWithArtifacts(input) {
      const id = randomUUID()
      const row = memRow({
        id,
        workspaceId: input.workspaceId,
        assistantRoutineId: input.assistantRoutineId,
        sourceAssistantId: input.sourceAssistantId ?? null,
        lensSessionId: input.lensSessionId ?? null,
        extensionRecordingId: input.extensionRecordingId ?? null,
        workflowId: null,
        status: 'importing',
        error: null,
      })
      imports.set(id, row)
      const list: RoutineArtifactRecord[] = []
      for (const a of input.artifacts) {
        const aid = randomUUID()
        const ar: RoutineArtifactRecord = {
          id: aid,
          workspaceId: input.workspaceId,
          importId: id,
          workflowId: null,
          kind: a.kind,
          storageUrl: a.storageUrl ?? null,
          inlineJson: a.inlineJson ?? null,
          contentType: a.contentType ?? null,
          sizeBytes: a.sizeBytes ?? null,
          retentionExpiresAt: null,
          createdAt: new Date(),
        }
        list.push(ar)
      }
      artifactsByImport.set(id, list)
      return row
    },
    async getById(workspaceId, id) {
      const row = imports.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      return row
    },
    async listArtifacts(workspaceId, importId) {
      const imp = imports.get(importId)
      if (!imp || imp.workspaceId !== workspaceId) return []
      return [...(artifactsByImport.get(importId) ?? [])]
    },
    async insertArtifact(input) {
      const imp = imports.get(input.importId)
      if (!imp || imp.workspaceId !== input.workspaceId) {
        throw new Error('import not found')
      }
      const aid = randomUUID()
      const ar: RoutineArtifactRecord = {
        id: aid,
        workspaceId: input.workspaceId,
        importId: input.importId,
        workflowId: null,
        kind: input.kind,
        storageUrl: input.storageUrl ?? null,
        inlineJson: input.inlineJson ?? null,
        contentType: input.contentType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        retentionExpiresAt: null,
        createdAt: new Date(),
      }
      const cur = artifactsByImport.get(input.importId) ?? []
      cur.push(ar)
      artifactsByImport.set(input.importId, cur)
      return ar
    },
    async promote(input) {
      const row = imports.get(input.importId)
      if (!row || row.workspaceId !== input.workspaceId) {
        throw new Error('not_found')
      }
      if (row.status === 'imported') {
        throw new Error('already_promoted')
      }
      if (row.status === 'failed') {
        throw new Error('failed_import')
      }
      const wf = await workflowsRepo.create({
        workspaceId: input.workspaceId,
        name: input.name,
        prompt: input.prompt,
        schedule: null,
        requiredCredentials: {},
        checkModules: checksToCheckModules(input.checks),
        enabled: true,
      })
      const prev = versionByWorkflow.get(wf.id) ?? 0
      const version = prev + 1
      versionByWorkflow.set(wf.id, version)
      const next = memRow({
        ...row,
        workflowId: wf.id,
        status: 'imported',
        updatedAt: new Date(),
      })
      imports.set(row.id, next)
      return {
        importId: row.id,
        workflowId: wf.id,
        version,
        status: 'imported' as const,
      }
    },
  }
}

// =============================================================================
// Drizzle impl
// =============================================================================

function rowToImport(row: typeof routineImportsTable.$inferSelect): RoutineImportRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    assistantRoutineId: row.assistantRoutineId,
    sourceAssistantId: row.sourceAssistantId,
    lensSessionId: row.lensSessionId,
    extensionRecordingId: row.extensionRecordingId,
    workflowId: row.workflowId,
    status: row.status as RoutineImportStatus,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToArtifact(
  row: typeof routineArtifactsTable.$inferSelect,
): RoutineArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    importId: row.importId,
    workflowId: row.workflowId,
    kind: row.kind,
    storageUrl: row.storageUrl,
    inlineJson: row.inlineJson,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    retentionExpiresAt: row.retentionExpiresAt,
    createdAt: row.createdAt,
  }
}

export function createDrizzleRoutineImportsRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): RoutineImportsRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async findByWorkspaceAndAssistantRoutineId(workspaceId, assistantRoutineId) {
      const rows = await db()
        .select()
        .from(routineImportsTable)
        .where(
          and(
            eq(routineImportsTable.workspaceId, workspaceId),
            eq(routineImportsTable.assistantRoutineId, assistantRoutineId),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? rowToImport(row) : null
    },
    async createWithArtifacts(input) {
      return await db().transaction(async (tx) => {
        const [row] = await tx
          .insert(routineImportsTable)
          .values({
            workspaceId: input.workspaceId,
            assistantRoutineId: input.assistantRoutineId,
            sourceAssistantId: input.sourceAssistantId,
            lensSessionId: input.lensSessionId,
            extensionRecordingId: input.extensionRecordingId,
            status: 'importing',
          })
          .returning()
        if (!row) throw new Error('routine import insert returned no row')
        if (input.artifacts.length) {
          await tx.insert(routineArtifactsTable).values(
            input.artifacts.map((a) => ({
              workspaceId: input.workspaceId,
              importId: row.id,
              kind: a.kind,
              storageUrl: a.storageUrl ?? null,
              inlineJson: a.inlineJson ?? null,
              contentType: a.contentType ?? null,
              sizeBytes: a.sizeBytes ?? null,
            })),
          )
        }
        return rowToImport(row)
      })
    },
    async getById(workspaceId, id) {
      const rows = await db()
        .select()
        .from(routineImportsTable)
        .where(
          and(
            eq(routineImportsTable.id, id),
            eq(routineImportsTable.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? rowToImport(row) : null
    },
    async listArtifacts(workspaceId, importId) {
      const rows = await db()
        .select()
        .from(routineArtifactsTable)
        .where(
          and(
            eq(routineArtifactsTable.importId, importId),
            eq(routineArtifactsTable.workspaceId, workspaceId),
          ),
        )
      return rows.map(rowToArtifact)
    },
    async insertArtifact(input) {
      const rows = await db()
        .insert(routineArtifactsTable)
        .values({
          workspaceId: input.workspaceId,
          importId: input.importId,
          kind: input.kind,
          storageUrl: input.storageUrl ?? null,
          inlineJson: input.inlineJson ?? null,
          contentType: input.contentType ?? null,
          sizeBytes: input.sizeBytes ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('artifact insert returned no row')
      return rowToArtifact(row)
    },
    async promote(input) {
      return await db().transaction(async (tx) => {
        const [imp] = await tx
          .select()
          .from(routineImportsTable)
          .where(
            and(
              eq(routineImportsTable.id, input.importId),
              eq(routineImportsTable.workspaceId, input.workspaceId),
            ),
          )
          .limit(1)
        if (!imp) throw new Error('not_found')
        if (imp.status === 'imported') throw new Error('already_promoted')
        if (imp.status === 'failed') throw new Error('failed_import')

        const [wf] = await tx
          .insert(workflowsTable)
          .values({
            workspaceId: input.workspaceId,
            name: input.name,
            prompt: input.prompt,
            schedule: null,
            requiredCredentials: {} as never,
            checkModules: checksToCheckModules(input.checks) as never,
            enabled: true,
          })
          .returning()
        if (!wf) throw new Error('workflow insert returned no row')

        const [agg] = await tx
          .select({ m: max(workflowVersionsTable.version) })
          .from(workflowVersionsTable)
          .where(eq(workflowVersionsTable.workflowId, wf.id))
        const nextVersion = (agg?.m ?? 0) + 1

        await tx.insert(workflowVersionsTable).values({
          workflowId: wf.id,
          version: nextVersion,
          prompt: input.prompt,
          steps: input.steps as never,
          parameters: input.parameters as never,
          checks: input.checks as never,
          sourceImportId: imp.id,
          createdBy: input.accountId,
        })

        const [updated] = await tx
          .update(routineImportsTable)
          .set({
            status: 'imported',
            workflowId: wf.id,
            updatedAt: new Date(),
          })
          .where(eq(routineImportsTable.id, imp.id))
          .returning()
        if (!updated) throw new Error('import update returned no row')

        return {
          importId: updated.id,
          workflowId: wf.id,
          version: nextVersion,
          status: 'imported' as const,
        }
      })
    },
  }
}

// =============================================================================
// Module facade
// =============================================================================

let activeRepo: RoutineImportsRepo | null = null

function selectDefaultRepo(): RoutineImportsRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRoutineImportsRepo()
  return createDrizzleRoutineImportsRepo()
}

function getRepo(): RoutineImportsRepo {
  if (!activeRepo) activeRepo = selectDefaultRepo()
  return activeRepo
}

export function findByWorkspaceAndAssistantRoutineId(
  workspaceId: string,
  assistantRoutineId: string,
): Promise<RoutineImportRecord | null> {
  return getRepo().findByWorkspaceAndAssistantRoutineId(
    workspaceId,
    assistantRoutineId,
  )
}

export function createWithArtifacts(
  input: CreateRoutineImportInput,
): Promise<RoutineImportRecord> {
  return getRepo().createWithArtifacts(input)
}

export function getById(
  workspaceId: string,
  id: string,
): Promise<RoutineImportRecord | null> {
  return getRepo().getById(workspaceId, id)
}

export function listArtifacts(
  workspaceId: string,
  importId: string,
): Promise<RoutineArtifactRecord[]> {
  return getRepo().listArtifacts(workspaceId, importId)
}

export function insertArtifact(
  input: InsertArtifactInput,
): Promise<RoutineArtifactRecord> {
  return getRepo().insertArtifact(input)
}

export function promote(
  input: PromoteRoutineImportInput,
): Promise<PromoteRoutineImportResult> {
  return getRepo().promote(input)
}

export function __setRoutineImportsRepoForTests(
  repo: RoutineImportsRepo | null,
): void {
  activeRepo = repo
}

export function __resetRoutineImportsRepoForTests(): void {
  if (activeRepo && '__reset' in activeRepo) {
    ;(activeRepo as { __reset: () => void }).__reset()
  } else {
    activeRepo = null
  }
}

/**
 * Audit log writer — Phase 05.
 *
 * Persists every tool call (pre + post) to `runtime.runtime_tool_calls` and
 * every typed step (model_thinking, model_tool_use, approval, check, ...)
 * to `runtime.runtime_run_steps`. The eventbus stays the live SSE seam;
 * this module is the durable side-channel for "what happened, in order,
 * forever" — the artifact a CFO audits a run against.
 *
 * Public surface:
 *   recordStepStart({ runId, stepIndex, kind, payload })           → { stepId }
 *   recordToolCallStart({ runId, stepIndex, toolName, params })   → { toolCallId }
 *   recordToolCallEnd({ toolCallId, result?, error?, screenshotS3Key?, modelLatencyMs?, browserLatencyMs?, costCents? })
 *   recordApprovalStep({ runId, stepIndex, payload })             → { stepId }
 *   recordCheckStep({ runId, stepIndex, payload })                → { stepId }
 *
 * Repos: `RunStepRepo` and `ToolCallRepo` mirror `RunStateRepo` exactly
 * (memory + Drizzle impls behind a module-level facade, NODE_ENV=test
 * picks memory). Tests can swap impls via `__set*ForTests`.
 *
 * Phase 05 keeps screenshot bytes inline: tool_result blocks ship base64
 * over SSE AND write the same base64 into `runtime_tool_calls.result`. The
 * `RuntimeScreenshotsBucket` is provisioned in `sst.config.ts` but NOT
 * wired here.
 *
 * TODO(Phase 05.5): move screenshot bytes to S3 (RuntimeScreenshotsBucket
 * already provisioned in `sst.config.ts`). `result` JSONB will store an
 * `{ screenshot_s3_key }` reference instead of inlined base64; the SSE
 * stream stays inline-base64 for low-latency previews. Migration is
 * additive — `result` keeps its shape, `screenshot_s3_key` column is
 * already on the table for this very purpose.
 */

import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import {
  runSteps as runStepsTable,
  toolCalls as toolCallsTable,
  type NewRunStep,
  type NewToolCall,
} from '../db/schema.js'

// =============================================================================
// Types
// =============================================================================

/**
 * Step kinds persisted in `runtime_run_steps.kind`. Matches the timeline
 * the dashboard renders: model thoughts, tool intent, approval pauses,
 * post-run checks, user takeovers.
 */
export type RunStepKind =
  | 'model_thinking'
  | 'model_tool_use'
  | 'tool_call'
  | 'approval'
  | 'check'
  | 'user_takeover'

export interface RecordStepStartInput {
  runId: string
  stepIndex: number
  kind: RunStepKind
  payload: Record<string, unknown>
}

export interface RecordToolCallStartInput {
  runId: string
  stepIndex: number
  toolName: string
  params: Record<string, unknown>
}

export interface RecordToolCallEndInput {
  toolCallId: string
  result?: Record<string, unknown> | null
  error?: string | null
  screenshotS3Key?: string | null
  modelLatencyMs?: number
  browserLatencyMs?: number
  costCents?: number
  approvalId?: string | null
  trustGrantId?: string | null
}

export interface StepRecord {
  stepId: string
  runId: string
  stepIndex: number
  kind: RunStepKind
  payload: Record<string, unknown>
  createdAt: string
}

export interface ToolCallRecord {
  toolCallId: string
  runId: string
  stepIndex: number
  toolName: string
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  screenshotS3Key: string | null
  approvalId: string | null
  trustGrantId: string | null
  modelLatencyMs: number | null
  browserLatencyMs: number | null
  costCents: number | null
  startedAt: string
  completedAt: string | null
}

// =============================================================================
// Repo interfaces
// =============================================================================

export interface RunStepRepo {
  insert(input: RecordStepStartInput): Promise<StepRecord>
  listByRun(runId: string, limit?: number, offset?: number): Promise<StepRecord[]>
}

export interface ToolCallRepo {
  insertStart(input: RecordToolCallStartInput): Promise<ToolCallRecord>
  updateEnd(input: RecordToolCallEndInput): Promise<ToolCallRecord>
  listByRun(
    runId: string,
    limit?: number,
    offset?: number,
  ): Promise<ToolCallRecord[]>
}

// =============================================================================
// Memory impls — used by every test except those that explicitly target
// the Drizzle path.
// =============================================================================

export function createMemoryRunStepRepo(): RunStepRepo & {
  __reset: () => void
  __all: () => StepRecord[]
} {
  const store: StepRecord[] = []
  let counter = 0
  return {
    async insert(input) {
      counter++
      const rec: StepRecord = {
        stepId: `step-${counter}-${Math.random().toString(36).slice(2, 8)}`,
        runId: input.runId,
        stepIndex: input.stepIndex,
        kind: input.kind,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      }
      store.push(rec)
      return rec
    },
    async listByRun(runId, limit, offset) {
      const all = store
        .filter((s) => s.runId === runId)
        .sort((a, b) => a.stepIndex - b.stepIndex)
      const start = offset ?? 0
      const end = limit !== undefined ? start + limit : undefined
      return all.slice(start, end)
    },
    __reset() {
      store.length = 0
      counter = 0
    },
    __all() {
      return [...store]
    },
  }
}

export function createMemoryToolCallRepo(): ToolCallRepo & {
  __reset: () => void
  __all: () => ToolCallRecord[]
} {
  const store = new Map<string, ToolCallRecord>()
  let counter = 0
  return {
    async insertStart(input) {
      counter++
      const id = `tc-${counter}-${Math.random().toString(36).slice(2, 8)}`
      const rec: ToolCallRecord = {
        toolCallId: id,
        runId: input.runId,
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        params: input.params,
        result: null,
        error: null,
        screenshotS3Key: null,
        approvalId: null,
        trustGrantId: null,
        modelLatencyMs: null,
        browserLatencyMs: null,
        costCents: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      }
      store.set(id, rec)
      return rec
    },
    async updateEnd(input) {
      const cur = store.get(input.toolCallId)
      if (!cur) {
        throw new Error(`tool call not found: ${input.toolCallId}`)
      }
      const next: ToolCallRecord = {
        ...cur,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.screenshotS3Key !== undefined
          ? { screenshotS3Key: input.screenshotS3Key }
          : {}),
        ...(input.approvalId !== undefined
          ? { approvalId: input.approvalId }
          : {}),
        ...(input.trustGrantId !== undefined
          ? { trustGrantId: input.trustGrantId }
          : {}),
        ...(input.modelLatencyMs !== undefined
          ? { modelLatencyMs: input.modelLatencyMs }
          : {}),
        ...(input.browserLatencyMs !== undefined
          ? { browserLatencyMs: input.browserLatencyMs }
          : {}),
        ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
        completedAt: new Date().toISOString(),
      }
      store.set(input.toolCallId, next)
      return next
    },
    async listByRun(runId, limit, offset) {
      const all = [...store.values()]
        .filter((tc) => tc.runId === runId)
        .sort((a, b) => {
          if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex
          return a.startedAt.localeCompare(b.startedAt)
        })
      const start = offset ?? 0
      const end = limit !== undefined ? start + limit : undefined
      return all.slice(start, end)
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
// Drizzle impls — write through to runtime.runtime_run_steps and
// runtime.runtime_tool_calls.
// =============================================================================

function stepRowToRecord(row: {
  id: string
  runId: string
  stepIndex: number
  kind: string
  payload: unknown
  createdAt: Date
}): StepRecord {
  return {
    stepId: row.id,
    runId: row.runId,
    stepIndex: row.stepIndex,
    kind: row.kind as RunStepKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }
}

function toolCallRowToRecord(row: {
  id: string
  runId: string
  stepIndex: number
  toolName: string
  params: unknown
  result: unknown
  error: string | null
  screenshotS3Key: string | null
  approvalId: string | null
  trustGrantId: string | null
  modelLatencyMs: number | null
  browserLatencyMs: number | null
  costCents: number | null
  startedAt: Date
  completedAt: Date | null
}): ToolCallRecord {
  return {
    toolCallId: row.id,
    runId: row.runId,
    stepIndex: row.stepIndex,
    toolName: row.toolName,
    params: (row.params ?? {}) as Record<string, unknown>,
    result: (row.result ?? null) as Record<string, unknown> | null,
    error: row.error,
    screenshotS3Key: row.screenshotS3Key,
    approvalId: row.approvalId,
    trustGrantId: row.trustGrantId,
    modelLatencyMs: row.modelLatencyMs,
    browserLatencyMs: row.browserLatencyMs,
    costCents: row.costCents,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  }
}

export function createDrizzleRunStepRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): RunStepRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)
  return {
    async insert(input) {
      const values: NewRunStep = {
        runId: input.runId,
        stepIndex: input.stepIndex,
        kind: input.kind,
        payload: input.payload,
      }
      const rows = await db().insert(runStepsTable).values(values).returning()
      const row = rows[0]
      if (!row) throw new Error('runtime_run_steps insert returned no row')
      return stepRowToRecord(row)
    },
    async listByRun(runId, limit, offset) {
      let q = db()
        .select()
        .from(runStepsTable)
        .where(eq(runStepsTable.runId, runId))
        .orderBy(runStepsTable.stepIndex) as unknown as {
        limit: (n: number) => unknown
        offset: (n: number) => unknown
        then: Promise<typeof runStepsTable.$inferSelect[]>['then']
      }
      if (limit !== undefined) q = q.limit(limit) as typeof q
      if (offset !== undefined) q = q.offset(offset) as typeof q
      const rows = (await (q as unknown as Promise<
        Array<typeof runStepsTable.$inferSelect>
      >)) as Array<typeof runStepsTable.$inferSelect>
      return rows.map(stepRowToRecord)
    },
  }
}

export function createDrizzleToolCallRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): ToolCallRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)
  return {
    async insertStart(input) {
      const values: NewToolCall = {
        runId: input.runId,
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        params: input.params,
      }
      const rows = await db().insert(toolCallsTable).values(values).returning()
      const row = rows[0]
      if (!row) throw new Error('runtime_tool_calls insert returned no row')
      return toolCallRowToRecord(row)
    },
    async updateEnd(input) {
      const patch: Partial<typeof toolCallsTable.$inferInsert> = {
        completedAt: new Date(),
      }
      if (input.result !== undefined) patch.result = input.result
      if (input.error !== undefined) patch.error = input.error
      if (input.screenshotS3Key !== undefined) {
        patch.screenshotS3Key = input.screenshotS3Key
      }
      if (input.approvalId !== undefined) patch.approvalId = input.approvalId
      if (input.trustGrantId !== undefined) {
        patch.trustGrantId = input.trustGrantId
      }
      if (input.modelLatencyMs !== undefined) {
        patch.modelLatencyMs = input.modelLatencyMs
      }
      if (input.browserLatencyMs !== undefined) {
        patch.browserLatencyMs = input.browserLatencyMs
      }
      if (input.costCents !== undefined) patch.costCents = input.costCents

      const rows = await db()
        .update(toolCallsTable)
        .set(patch)
        .where(eq(toolCallsTable.id, input.toolCallId))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`tool call not found: ${input.toolCallId}`)
      return toolCallRowToRecord(row)
    },
    async listByRun(runId, limit, offset) {
      let q = db()
        .select()
        .from(toolCallsTable)
        .where(eq(toolCallsTable.runId, runId))
        .orderBy(toolCallsTable.stepIndex, toolCallsTable.startedAt) as unknown as {
        limit: (n: number) => unknown
        offset: (n: number) => unknown
      }
      if (limit !== undefined) q = q.limit(limit) as typeof q
      if (offset !== undefined) q = q.offset(offset) as typeof q
      const rows = (await (q as unknown as Promise<
        Array<typeof toolCallsTable.$inferSelect>
      >)) as Array<typeof toolCallsTable.$inferSelect>
      return rows.map(toolCallRowToRecord)
    },
  }
}

// =============================================================================
// Module-level facade. Memory impls under NODE_ENV=test, Drizzle elsewhere.
// =============================================================================

let activeStepRepo: RunStepRepo | null = null
let activeToolCallRepo: ToolCallRepo | null = null

function selectDefaultStepRepo(): RunStepRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryRunStepRepo()
  return createDrizzleRunStepRepo()
}
function selectDefaultToolCallRepo(): ToolCallRepo {
  if (process.env.NODE_ENV === 'test') return createMemoryToolCallRepo()
  return createDrizzleToolCallRepo()
}

function getStepRepo(): RunStepRepo {
  if (!activeStepRepo) activeStepRepo = selectDefaultStepRepo()
  return activeStepRepo
}
function getToolCallRepo(): ToolCallRepo {
  if (!activeToolCallRepo) activeToolCallRepo = selectDefaultToolCallRepo()
  return activeToolCallRepo
}

// =============================================================================
// Public API — concise verbs the orchestrator wires into agent loop +
// dispatcher + approval middleware.
// =============================================================================

/**
 * Persist a step-start row. Returns the new step's id.
 *
 * `(run_id, step_index)` is unique in `runtime_run_steps`; the caller is
 * responsible for monotonic step_index allocation per run (see the
 * step-index counter helper below).
 */
export async function recordStepStart(
  input: RecordStepStartInput,
): Promise<{ stepId: string }> {
  const rec = await getStepRepo().insert(input)
  return { stepId: rec.stepId }
}

/**
 * Persist a tool-call-start row with `started_at = now()` and `result = null`.
 * Returns the new row's id; the caller pairs this with `recordToolCallEnd`
 * after the harness call (success OR failure) to UPDATE the same row.
 */
export async function recordToolCallStart(
  input: RecordToolCallStartInput,
): Promise<{ toolCallId: string }> {
  const rec = await getToolCallRepo().insertStart(input)
  return { toolCallId: rec.toolCallId }
}

/**
 * UPDATE the tool-call row with the post-execution shape: result blocks,
 * error text, screenshot key, latency, cost. Idempotent in spirit — the
 * row's `completed_at` flips from NULL to now() exactly once per call site.
 */
export async function recordToolCallEnd(
  input: RecordToolCallEndInput,
): Promise<void> {
  await getToolCallRepo().updateEnd(input)
}

/**
 * Persist an approval step. Called when the approval middleware creates a
 * pending approval row — NOT on resolve. Resolve updates the approval row
 * itself; the step row is created once and stays as the timeline anchor.
 */
export async function recordApprovalStep(input: {
  runId: string
  stepIndex: number
  payload: Record<string, unknown>
}): Promise<{ stepId: string }> {
  return recordStepStart({
    runId: input.runId,
    stepIndex: input.stepIndex,
    kind: 'approval',
    payload: input.payload,
  })
}

/**
 * Persist a check step. Phase 06 owner calls this; placed here so both
 * audit step kinds live in one module (parity with the runtime_run_steps
 * `kind` enum vs scattering writers across modules).
 */
export async function recordCheckStep(input: {
  runId: string
  stepIndex: number
  payload: Record<string, unknown>
}): Promise<{ stepId: string }> {
  return recordStepStart({
    runId: input.runId,
    stepIndex: input.stepIndex,
    kind: 'check',
    payload: input.payload,
  })
}

// =============================================================================
// Step-index allocator. Per-run monotonic counter so call sites don't have
// to coordinate index ownership across modules (agent loop + dispatcher +
// approval middleware all write to the same run timeline).
//
// Process-local Map; survives the lifetime of the orchestrator fiber.
// `(run_id, step_index)` uniqueness is enforced by the DB, so a duplicate
// allocation surfaces as an INSERT error rather than silent corruption.
// =============================================================================

const stepCounters = new Map<string, number>()

/** Get the next step index for a run. Starts at 0, monotonic per run. */
export function nextStepIndex(runId: string): number {
  const cur = stepCounters.get(runId) ?? 0
  stepCounters.set(runId, cur + 1)
  return cur
}

/** Reset a run's step counter — used at run finalization to avoid leaks. */
export function resetStepIndex(runId: string): void {
  stepCounters.delete(runId)
}

// =============================================================================
// Read helpers — used by the audit query routes.
// =============================================================================

export async function listRunSteps(
  runId: string,
  limit?: number,
  offset?: number,
): Promise<StepRecord[]> {
  return getStepRepo().listByRun(runId, limit, offset)
}

export async function listToolCalls(
  runId: string,
  limit?: number,
  offset?: number,
): Promise<ToolCallRecord[]> {
  return getToolCallRepo().listByRun(runId, limit, offset)
}

// =============================================================================
// Test-only injectors. Mirrors the `runState` / `approvalsRepo` style.
// =============================================================================

export function __setRunStepRepoForTests(repo: RunStepRepo | null): void {
  activeStepRepo = repo
}
export function __setToolCallRepoForTests(repo: ToolCallRepo | null): void {
  activeToolCallRepo = repo
}

export function __resetForTests(): void {
  if (activeStepRepo && '__reset' in activeStepRepo) {
    ;(activeStepRepo as { __reset: () => void }).__reset()
  }
  if (activeToolCallRepo && '__reset' in activeToolCallRepo) {
    ;(activeToolCallRepo as { __reset: () => void }).__reset()
  }
  stepCounters.clear()
}

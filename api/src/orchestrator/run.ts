/**
 * Run orchestrator entrypoint.
 *
 * `startRun` is a fire-and-forget: it creates the Browserbase session,
 * registers the run in `runState`, kicks off the workflow on a fresh
 * async fiber, and returns the run identifiers immediately so the caller
 * can subscribe to events before the workflow starts emitting.
 *
 * The fiber is responsible for: attaching a CDP session via the harness,
 * running the workflow, emitting `run_completed` / `run_failed`,
 * detaching the harness session, stopping the Browserbase session, and
 * closing the eventbus channel. Any error inside the fiber is caught and
 * routed through the same teardown path.
 *
 * Phase 10 — workflow library:
 *  - The two original built-in workflow IDs (`hello-world`,
 *    `agent-helloworld`) are reserved bootstrap names. They never need a
 *    DB row and continue to dispatch to the original handlers.
 *  - Anything else is treated as a `runtime_workflows` UUID, looked up
 *    via `workflowsRepo.get(workspaceId, id)`, and dispatched through a
 *    synthetic agent-loop handler that reads `prompt` + `check_modules`
 *    off the row.
 *  - `WorkflowNotFoundError` / `WorkflowDisabledError` / `WorkflowAccessDeniedError`
 *    surface to the route layer so the API can return 404 / 409 / 403.
 */

import { randomUUID } from 'node:crypto'
import { attach, detach } from '@basics/harness'
import type { CdpSession } from '@basics/harness'
import type { ScheduledCheck } from '../checks/types.js'
import {
  buildScheduledChecks,
  type CheckModuleSpec,
} from '../checks/registry.js'
import {
  createSession as createBrowserbaseSession,
  stopSession as stopBrowserbaseSession,
} from '../lib/browserbase.js'
import { logger } from '../middleware/logger.js'
import { resetStepIndex } from './auditWriter.js'
import { runChecks } from './checkRunner.js'
import { close as closeChannel, publish } from './eventbus.js'
import { register, update } from './runState.js'
import { runAgentHelloWorld } from './workflows/agentHelloWorld.js'
import { runHelloWorld } from './workflows/helloWorld.js'
import { runAgentLoop } from './agentLoop.js'
import { get as getWorkflowRow } from './workflowsRepo.js'

/**
 * Built-in workflow names. Phase 10 keeps these as reserved bootstrap
 * IDs that never need a DB row. Any other `workflow_id` is interpreted
 * as a `runtime_workflows.id` UUID and looked up at run time.
 */
export type BuiltInWorkflowId = 'hello-world' | 'agent-helloworld'

export const BUILT_IN_WORKFLOW_IDS: readonly BuiltInWorkflowId[] = [
  'hello-world',
  'agent-helloworld',
] as const

export function isBuiltInWorkflowId(value: string): value is BuiltInWorkflowId {
  return (BUILT_IN_WORKFLOW_IDS as readonly string[]).includes(value)
}

/**
 * Back-compat alias. Phase 01 → 09 callers (and the legacy route
 * validator) imported `WorkflowId` + `isKnownWorkflowId` to gate the
 * built-in enum. Phase 10 widens the route to accept any string and lets
 * the orchestrator validate; these exports stay so existing call sites
 * don't churn.
 */
export type WorkflowId = BuiltInWorkflowId
export const WORKFLOW_IDS = BUILT_IN_WORKFLOW_IDS
export const isKnownWorkflowId = isBuiltInWorkflowId

// =============================================================================
// Errors surfaced to the route layer.
// =============================================================================

export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`workflow not found: ${workflowId}`)
    this.name = 'WorkflowNotFoundError'
  }
}

export class WorkflowDisabledError extends Error {
  constructor(workflowId: string) {
    super(`workflow disabled: ${workflowId}`)
    this.name = 'WorkflowDisabledError'
  }
}

// =============================================================================
// Resolution: built-in vs DB row.
// =============================================================================

interface BuiltInResolution {
  kind: 'builtin'
  id: BuiltInWorkflowId
}

interface DbResolution {
  kind: 'db'
  id: string
  name: string
  prompt: string
  checkModules: Array<{ name: string; params: Record<string, unknown> }>
}

type ResolvedWorkflow = BuiltInResolution | DbResolution

/**
 * Resolve a `workflow_id` against either the built-in registry (by name)
 * or the workspace's `runtime_workflows` rows (by UUID).
 *
 * Throws `WorkflowNotFoundError` if the id is neither a known built-in
 * nor a workflow owned by the supplied workspace. Throws
 * `WorkflowDisabledError` if a DB-backed workflow exists but has
 * `enabled=false`.
 */
export async function resolveWorkflow(
  workspaceId: string,
  workflowId: string,
): Promise<ResolvedWorkflow> {
  if (isBuiltInWorkflowId(workflowId)) {
    return { kind: 'builtin', id: workflowId }
  }
  const row = await getWorkflowRow(workspaceId, workflowId)
  if (!row) throw new WorkflowNotFoundError(workflowId)
  if (!row.enabled) throw new WorkflowDisabledError(workflowId)
  return {
    kind: 'db',
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    checkModules: row.checkModules,
  }
}

/**
 * Phase 06: per-workflow check schedules.
 *
 * Built-in workflows return `[]` (preserves the Phase 06 contract — the
 * runner short-circuits with `outcome: 'no_checks'` and the run keeps
 * its existing `completed` status). DB-backed workflows compose checks
 * from the row's `check_modules` column via the registry in
 * `api/src/checks/registry.ts`.
 */
function checksForWorkflow(resolved: ResolvedWorkflow): ScheduledCheck[] {
  if (resolved.kind === 'builtin') return []
  const specs: CheckModuleSpec[] = resolved.checkModules.map((entry) => ({
    name: entry.name,
    params: entry.params,
  }))
  return buildScheduledChecks(specs)
}

export interface StartRunInput {
  workspaceId: string
  /**
   * Either a built-in workflow id (`'hello-world'` | `'agent-helloworld'`)
   * or a `runtime_workflows.id` UUID. Validation happens server-side; the
   * route layer no longer pre-checks against the built-in enum.
   */
  workflowId: string
}

export interface StartRunResult {
  runId: string
  browserbaseSessionId: string
  liveUrl: string
}

export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  // Resolve before booting Browserbase so a 404 / 409 surfaces as the
  // POST response rather than as a `run_failed` event after the session
  // is already alive (and billable).
  const resolved = await resolveWorkflow(input.workspaceId, input.workflowId)

  const runId = randomUUID()

  // Create the Browserbase session synchronously — the live URL must be
  // returned to the caller, and any failure here should surface as the
  // POST response, not as a `run_failed` event.
  const bb = await createBrowserbaseSession({
    workspaceId: input.workspaceId,
    runId,
  })

  const startedAt = new Date().toISOString()
  await register({
    runId,
    workspaceId: input.workspaceId,
    workflowId: resolved.id,
    status: 'running',
    browserbaseSessionId: bb.sessionId,
    liveUrl: bb.liveUrl,
    startedAt,
  })

  // Emit run_started before returning — late SSE consumers will see this
  // via the replay buffer.
  publish(runId, {
    type: 'run_started',
    data: { run_id: runId, started_at: startedAt },
  })

  // Detached fiber. We intentionally do not await this Promise; we also
  // attach a `.catch` because an unhandled rejection here would crash the
  // process (Node 22 default).
  void runFiber(
    runId,
    input.workspaceId,
    bb.sessionId,
    bb.cdpWsUrl,
    resolved,
  ).catch((err) => {
    logger.error(
      {
        run_id: runId,
        err: { message: (err as Error).message, stack: (err as Error).stack },
      },
      'orchestrator fiber escaped error handler',
    )
  })

  return {
    runId,
    browserbaseSessionId: bb.sessionId,
    liveUrl: bb.liveUrl,
  }
}

const DB_WORKFLOW_SYSTEM_PROMPT_PREFIX =
  'You are an AI agent running inside a cloud Chrome browser. ' +
  'Use the computer tool to complete the task described below. ' +
  'When you are done, write a brief summary of what you accomplished.'

async function runFiber(
  runId: string,
  workspaceId: string,
  browserbaseSessionId: string,
  cdpWsUrl: string,
  resolved: ResolvedWorkflow,
): Promise<void> {
  let session: CdpSession | null = null
  try {
    session = await attach({ wsUrl: cdpWsUrl })

    const emit = (type: string, data: Record<string, unknown>) => {
      publish(runId, { type: type as Parameters<typeof publish>[1]['type'], data })
    }

    if (resolved.kind === 'builtin') {
      if (resolved.id === 'hello-world') {
        await runHelloWorld({
          runId,
          session,
          emit,
          workspaceId,
          workflowId: resolved.id,
        })
      } else if (resolved.id === 'agent-helloworld') {
        await runAgentHelloWorld({
          runId,
          session,
          emit,
          workspaceId,
          workflowId: resolved.id,
        })
      } else {
        // Unreachable today — `BuiltInWorkflowId` is exhaustively typed
        // and the route hands us the resolved value. Future-proof the
        // fiber so adding a new built-in name forces the compiler to
        // visit this switch.
        const _exhaustive: never = resolved.id
        throw new Error(`unknown built-in workflow_id: ${String(_exhaustive)}`)
      }
    } else {
      // DB-backed workflow. Dispatch through the agent loop with the
      // row's prompt as the user turn. The system prompt prefix matches
      // the built-in `agentHelloWorld` style so model behavior stays
      // consistent regardless of how the workflow is configured.
      const result = await runAgentLoop({
        runId,
        session,
        systemPrompt: DB_WORKFLOW_SYSTEM_PROMPT_PREFIX,
        userPrompt: resolved.prompt,
        workspaceId,
        workflowId: resolved.id,
      })
      publish(runId, {
        type: 'agent_summary',
        data: {
          text: result.finalText,
          iterations: result.iterations,
          hit_max_iterations: result.hitMaxIterations,
          ts: new Date().toISOString(),
        },
      })
    }

    // Phase 06: post-workflow check execution. Returns an outcome of
    // `verified` / `unverified` / `no_checks`. We map outcome onto the
    // run's terminal status (verified|unverified for non-empty schedules,
    // `completed` for empty so we don't regress the existing fiber
    // contract). `run_completed` is still emitted afterwards so existing
    // SSE consumers don't break.
    const summary = await runChecks({
      runId,
      workspaceId,
      workflowId: resolved.id,
      session,
      checks: checksForWorkflow(resolved),
    })

    const finalStatus =
      summary.outcome === 'verified'
        ? 'verified'
        : summary.outcome === 'unverified'
          ? 'unverified'
          : 'completed'

    const completedAt = new Date().toISOString()
    const updatePatch: Parameters<typeof update>[1] = {
      status: finalStatus,
      completedAt,
    }
    await update(runId, updatePatch)
    publish(runId, {
      type: 'run_completed',
      data: {
        run_id: runId,
        completed_at: completedAt,
        status: finalStatus,
        checks: {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
        },
      },
    })
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    const completedAt = new Date().toISOString()
    try {
      await update(runId, { status: 'failed', completedAt })
    } catch {
      // run was never registered (createSession threw before register)
      // — nothing to update; just log.
    }
    publish(runId, {
      type: 'run_failed',
      data: { run_id: runId, error: errMessage, completed_at: completedAt },
    })
    logger.error(
      { run_id: runId, err: { message: errMessage } },
      'run failed',
    )
  } finally {
    if (session) {
      await detach(session).catch((err) => {
        logger.warn(
          { run_id: runId, err: { message: (err as Error).message } },
          'detach failed',
        )
      })
    }
    await stopBrowserbaseSession(browserbaseSessionId).catch((err) => {
      logger.warn(
        { run_id: runId, err: { message: (err as Error).message } },
        'browserbase stopSession failed',
      )
    })
    // Phase 05: drop the per-run step-index counter so it doesn't leak
    // across long-running processes.
    resetStepIndex(runId)
    closeChannel(runId)
  }
}

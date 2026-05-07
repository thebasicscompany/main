/**
 * Approval gating middleware — Phase 04B.
 *
 * Internal (NOT Hono) middleware sitting between the agent loop's tool
 * dispatcher and the harness call. The dispatcher invokes `gateToolCall`
 * for every tool call; the function decides whether to allow execution,
 * deny it, or block until a human approves it.
 *
 * Decision tree:
 *   1. requiresApproval=false               → allow (no_gate)
 *   2. trust ledger has matching grant      → allow (trust_grant)
 *   3. otherwise                            → create approval row, emit
 *      `approval_pending`, await resolution. On approve → allow. On
 *      reject → deny('user_rejected'). On 30-min timeout → deny('timeout').
 */

import type { RunEvent, RunEventType } from '../orchestrator/eventbus.js'
import * as approvalsRepo from '../orchestrator/approvalsRepo.js'
import { awaitResolution } from '../orchestrator/approvalSignal.js'
import {
  nextStepIndex,
  recordApprovalStep,
} from '../orchestrator/auditWriter.js'
import * as trustLedger from '../orchestrator/trustLedger.js'
import { logger } from './logger.js'

/** Default approval expiry — 30 minutes per Phase 04 spec. */
export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000

export type GateAllow =
  | { kind: 'allow'; via: 'no_gate' }
  | { kind: 'allow'; via: 'trust_grant'; grantId: string }
  | { kind: 'allow'; via: 'user_approved'; approvalId: string }

export type GateDeny =
  | {
      kind: 'deny'
      reason: 'user_rejected' | 'timeout'
      approvalId: string
    }

export type GateDecision = GateAllow | GateDeny

export interface GateToolCallInput {
  runId: string
  workspaceId: string
  workflowId?: string
  toolName: string
  params: Record<string, unknown>
  requiresApproval: boolean
  /**
   * Event sink. The dispatcher passes its `publish`-bound emitter so the
   * middleware doesn't import the eventbus directly (keeps it test-isolable
   * and decouples from how the run wiring is done).
   */
  emit: (event: { type: RunEventType; data: Record<string, unknown> }) => void
}

/**
 * Gate a tool call. See decision tree at the top of the file.
 */
export async function gateToolCall(
  input: GateToolCallInput,
): Promise<GateDecision> {
  if (!input.requiresApproval) {
    return { kind: 'allow', via: 'no_gate' }
  }

  // Trust ledger first.
  try {
    const grant = await trustLedger.findMatching({
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      params: input.params,
      workflowId: input.workflowId,
    })
    if (grant) {
      return { kind: 'allow', via: 'trust_grant', grantId: grant.id }
    }
  } catch (err) {
    // A failed trust-ledger lookup must not auto-approve; fall through to
    // the human-approval path. Log so the operator notices.
    logger.warn(
      {
        run_id: input.runId,
        tool_name: input.toolName,
        err: { message: (err as Error).message },
      },
      'trust ledger lookup failed; falling back to human approval',
    )
  }

  // No grant — persist a pending row and block.
  const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS)
  const approval = await approvalsRepo.create({
    runId: input.runId,
    workspaceId: input.workspaceId,
    toolName: input.toolName,
    params: input.params,
    expiresAt,
  })

  // Phase 05: persist an `approval` step on creation so the run timeline
  // has a durable anchor. We deliberately do NOT write a second step on
  // resolve — the approvals row itself flips status, so the resolve event
  // has its own audit trail without doubling timeline entries. Audit
  // failure is best-effort; the approval row + signal path is authoritative.
  try {
    await recordApprovalStep({
      runId: input.runId,
      stepIndex: nextStepIndex(input.runId),
      payload: {
        approval_id: approval.id,
        tool_name: approval.toolName,
        params: approval.params,
        expires_at: approval.expiresAt,
        ts: new Date().toISOString(),
      },
    })
  } catch (err) {
    logger.warn(
      {
        run_id: input.runId,
        approval_id: approval.id,
        err: { message: (err as Error).message },
      },
      'audit recordApprovalStep failed; approval flow continues',
    )
  }

  input.emit({
    type: 'approval_pending',
    data: {
      approval_id: approval.id,
      run_id: approval.runId,
      tool_name: approval.toolName,
      params: approval.params,
      expires_at: approval.expiresAt,
      ts: new Date().toISOString(),
    },
  })

  const resolution = await awaitResolution(approval.id, expiresAt)

  if (resolution.source === 'timeout') {
    // Timeout fires *only* if no `signalResolution` arrived before the
    // deadline. The DB row is still `pending` at this point — flip it to
    // `timeout` so the route layer's later 409 check is correct.
    try {
      await approvalsRepo.resolve(approval.id, {
        decision: 'timeout',
        resolvedVia: 'system',
      })
    } catch (err) {
      // Another writer beat us (e.g., a late overlay click that raced the
      // setTimeout). The Promise's source is still authoritative here:
      // we waited 30 minutes; whoever resolved during that window did
      // not signal us, so the dispatcher path proceeds as if timed out.
      logger.warn(
        {
          run_id: input.runId,
          approval_id: approval.id,
          err: { message: (err as Error).message },
        },
        'approval row already resolved when marking timeout',
      )
    }
    input.emit({
      type: 'approval_timeout',
      data: {
        approval_id: approval.id,
        ts: new Date().toISOString(),
      },
    })
    return { kind: 'deny', reason: 'timeout', approvalId: approval.id }
  }

  // User decision (resolution.source === 'user').
  input.emit({
    type: 'approval_resolved',
    data: {
      approval_id: approval.id,
      decision: resolution.decision,
      resolved_via: 'overlay',
      ts: new Date().toISOString(),
    },
  })

  if (resolution.decision === 'approve') {
    return { kind: 'allow', via: 'user_approved', approvalId: approval.id }
  }
  return { kind: 'deny', reason: 'user_rejected', approvalId: approval.id }
}

/** Marker re-export so consumers can typecheck the eventbus event shape. */
export type { RunEvent }

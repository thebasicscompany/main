/**
 * gateToolCall middleware tests.
 *
 * Covers the four observable outcomes:
 *   1. requiresApproval=false → instant allow (no row, no events)
 *   2. matching trust grant   → instant allow
 *   3. no grant + user approves → emits approval_pending then approval_resolved, allows
 *   4. no grant + user rejects  → emits approval_pending then approval_resolved, denies
 *   5. no grant + timeout       → emits approval_pending then approval_timeout, denies
 *
 * Vitest fake timers drive the timeout case so the test isn't waiting 30
 * minutes of wall-clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetForTests as resetApprovals,
  __setApprovalRepoForTests,
  createMemoryRepo as createApprovalsMemoryRepo,
} from '../orchestrator/approvalsRepo.js'
import {
  __resetForTests as resetSignals,
  signalResolution,
} from '../orchestrator/approvalSignal.js'
import {
  __resetForTests as resetTrust,
  __setTrustGrantRepoForTests,
  create as createTrustGrant,
  createMemoryRepo as createTrustMemoryRepo,
} from '../orchestrator/trustLedger.js'
import { gateToolCall } from './approval.js'

interface CapturedEvent {
  type: string
  data: Record<string, unknown>
}

function captureEmit() {
  const events: CapturedEvent[] = []
  return {
    events,
    emit: (e: CapturedEvent) => {
      events.push(e)
    },
  }
}

beforeEach(() => {
  __setApprovalRepoForTests(createApprovalsMemoryRepo())
  __setTrustGrantRepoForTests(createTrustMemoryRepo())
  resetSignals()
})

afterEach(() => {
  resetApprovals()
  resetTrust()
  resetSignals()
  __setApprovalRepoForTests(null)
  __setTrustGrantRepoForTests(null)
  vi.useRealTimers()
})

describe('gateToolCall', () => {
  it('returns allow/no_gate when requiresApproval=false', async () => {
    const sink = captureEmit()
    const r = await gateToolCall({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.screenshot',
      params: {},
      requiresApproval: false,
      emit: sink.emit,
    })
    expect(r).toEqual({ kind: 'allow', via: 'no_gate' })
    expect(sink.events).toHaveLength(0)
  })

  it('returns allow/trust_grant when ledger matches', async () => {
    await createTrustGrant({
      workspaceId: 'ws-1',
      grantedBy: 'user-1',
      actionPattern: 'computer.left_click',
      scope: 'workspace',
    })
    const sink = captureEmit()
    const r = await gateToolCall({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 100, y: 200 },
      requiresApproval: true,
      emit: sink.emit,
    })
    expect(r.kind).toBe('allow')
    if (r.kind === 'allow') expect(r.via).toBe('trust_grant')
    expect(sink.events).toHaveLength(0)
  })

  it('emits approval_pending → approval_resolved and allows on user approve', async () => {
    const sink = captureEmit()
    const gatePromise = gateToolCall({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 5 },
      requiresApproval: true,
      emit: sink.emit,
    })

    // Yield so the middleware reaches `awaitResolution` and registers the
    // waiter. With real timers a short setTimeout(0) suffices; we just
    // chain off a microtask repeatedly.
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(sink.events.length).toBeGreaterThan(0)
    const pending = sink.events.find((e) => e.type === 'approval_pending')
    expect(pending).toBeTruthy()
    const approvalId = pending!.data.approval_id as string
    expect(approvalId).toBeTypeOf('string')

    const signaled = signalResolution(approvalId, 'approve')
    expect(signaled).toBe(true)

    const r = await gatePromise
    expect(r.kind).toBe('allow')
    if (r.kind === 'allow') expect(r.via).toBe('user_approved')

    const resolved = sink.events.find((e) => e.type === 'approval_resolved')
    expect(resolved).toBeTruthy()
    expect(resolved!.data.decision).toBe('approve')
  })

  it('emits approval_pending → approval_resolved and denies on user reject', async () => {
    const sink = captureEmit()
    const gatePromise = gateToolCall({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 5 },
      requiresApproval: true,
      emit: sink.emit,
    })

    for (let i = 0; i < 5; i++) await Promise.resolve()

    const pending = sink.events.find((e) => e.type === 'approval_pending')!
    const approvalId = pending.data.approval_id as string
    signalResolution(approvalId, 'reject')

    const r = await gatePromise
    expect(r.kind).toBe('deny')
    if (r.kind === 'deny') expect(r.reason).toBe('user_rejected')

    const resolved = sink.events.find((e) => e.type === 'approval_resolved')
    expect(resolved!.data.decision).toBe('reject')
  })

  it('times out after 30 minutes if no resolution arrives', async () => {
    vi.useFakeTimers()
    const sink = captureEmit()
    const gatePromise = gateToolCall({
      runId: 'run-1',
      workspaceId: 'ws-1',
      toolName: 'computer.left_click',
      params: { x: 5 },
      requiresApproval: true,
      emit: sink.emit,
    })

    // Advance enough microtasks for `awaitResolution`'s setTimeout to be
    // armed before we jump the clock.
    await vi.advanceTimersByTimeAsync(0)
    expect(sink.events.find((e) => e.type === 'approval_pending')).toBeTruthy()

    // Jump past the 30-min deadline. Use 30 * 60 * 1000 + 1.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1)

    const r = await gatePromise
    expect(r.kind).toBe('deny')
    if (r.kind === 'deny') expect(r.reason).toBe('timeout')

    expect(sink.events.find((e) => e.type === 'approval_timeout')).toBeTruthy()
    // No `approval_resolved` event on the timeout path (we emit the dedicated
    // timeout event instead).
    expect(sink.events.find((e) => e.type === 'approval_resolved')).toBeFalsy()
  })
})

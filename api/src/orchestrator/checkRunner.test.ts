/**
 * checkRunner — Phase 06 unit tests.
 *
 * Verifies:
 *   - All-pass → outcome=verified.
 *   - Any-fail → outcome=unverified.
 *   - Empty schedule → outcome=no_checks.
 *   - check_started + check_completed events emitted in correct order.
 *   - Each check persists exactly one row to the results repo.
 *   - A check throwing is caught and recorded as failed (not propagated).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckFn, ScheduledCheck } from '../checks/types.js'
import {
  __resetForTests as resetCheckResultsRepo,
  __setCheckResultsRepoForTests,
  createMemoryRepo,
  listForRun,
  type CheckResultsRepo,
} from './checkResultsRepo.js'
import { runChecks } from './checkRunner.js'
import {
  __resetForTests as resetEventbus,
  publish as _publish,
  subscribe,
  close as closeChannel,
  type RunEvent,
} from './eventbus.js'

void _publish

let memoryRepo: CheckResultsRepo & { __reset: () => void }

beforeEach(() => {
  memoryRepo = createMemoryRepo()
  __setCheckResultsRepoForTests(memoryRepo)
})

afterEach(() => {
  resetCheckResultsRepo()
  __setCheckResultsRepoForTests(null)
  resetEventbus()
})

const passing: CheckFn = async () => ({
  passed: true,
  evidence: { ok: true },
})
const failing: CheckFn = async () => ({
  passed: false,
  evidence: { reason: 'simulated' },
})
const throwing: CheckFn = async () => {
  throw new Error('boom')
}

const sched = (name: string, fn: CheckFn): ScheduledCheck => ({ name, fn })

async function drainChannel(runId: string): Promise<RunEvent[]> {
  // Subscribe FIRST so a fresh channel exists, then close() — that
  // sequence terminates the iterator after the replay buffer drains.
  // Calling close() when no channel exists is a no-op (subsequent
  // subscribe spins up an empty channel that hangs forever), so we have
  // to seed it ourselves.
  const iter = subscribe(runId)
  closeChannel(runId)
  const out: RunEvent[] = []
  for await (const evt of iter) {
    out.push(evt)
  }
  return out
}

describe('checkRunner', () => {
  it('returns no_checks for an empty schedule and emits no events', async () => {
    const runId = 'run-empty'
    const summary = await runChecks({
      runId,
      workspaceId: 'ws-1',
      checks: [],
    })
    expect(summary).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      outcome: 'no_checks',
    })
    const events = await drainChannel(runId)
    expect(events).toHaveLength(0)
    expect(await listForRun(runId)).toHaveLength(0)
  })

  it('returns outcome=verified when every check passes', async () => {
    const runId = 'run-pass'
    const summary = await runChecks({
      runId,
      workspaceId: 'ws-1',
      checks: [sched('a', passing), sched('b', passing)],
    })
    expect(summary).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      outcome: 'verified',
    })
    const rows = await listForRun(runId)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.passed)).toBe(true)
    expect(rows.map((r) => r.checkName).sort()).toEqual(['a', 'b'])
  })

  it('returns outcome=unverified when any check fails', async () => {
    const runId = 'run-mix'
    const summary = await runChecks({
      runId,
      workspaceId: 'ws-1',
      checks: [sched('ok', passing), sched('bad', failing)],
    })
    expect(summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      outcome: 'unverified',
    })
    const rows = await listForRun(runId)
    const byName = new Map(rows.map((r) => [r.checkName, r]))
    expect(byName.get('ok')?.passed).toBe(true)
    expect(byName.get('bad')?.passed).toBe(false)
  })

  it('emits check_started + check_completed in order with payload', async () => {
    const runId = 'run-evt'
    await runChecks({
      runId,
      workspaceId: 'ws-1',
      checks: [sched('only', passing)],
    })
    const events = await drainChannel(runId)
    expect(events.map((e) => e.type)).toEqual([
      'check_started',
      'check_completed',
    ])
    const completed = events[1]!
    expect(completed.data.check_name).toBe('only')
    expect(completed.data.passed).toBe(true)
    expect(completed.data.evidence).toEqual({ ok: true })
  })

  it('catches check exceptions and records them as failures', async () => {
    const runId = 'run-throw'
    const summary = await runChecks({
      runId,
      workspaceId: 'ws-1',
      checks: [sched('throws', throwing), sched('ok', passing)],
    })
    expect(summary.failed).toBe(1)
    expect(summary.passed).toBe(1)
    expect(summary.outcome).toBe('unverified')
    const rows = await listForRun(runId)
    const byName = new Map(rows.map((r) => [r.checkName, r]))
    expect(byName.get('throws')?.passed).toBe(false)
    const evidence = byName.get('throws')!.evidence as Record<string, unknown>
    expect(evidence.reason).toBe('check_threw')
    expect(evidence.error).toBe('boom')
  })

  it('runs checks sequentially in declared order', async () => {
    const runId = 'run-order'
    const order: string[] = []
    const tracker = (name: string): CheckFn => async () => {
      order.push(name)
      return { passed: true, evidence: null }
    }
    await runChecks({
      runId,
      workspaceId: 'ws-1',
      checks: [
        sched('first', tracker('first')),
        sched('second', tracker('second')),
        sched('third', tracker('third')),
      ],
    })
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('passes runResult and toolCredentials through CheckContext', async () => {
    const runId = 'run-ctx'
    let captured: unknown = null
    const inspect: CheckFn = async (ctx) => {
      captured = ctx
      return { passed: true, evidence: null }
    }
    await runChecks({
      runId,
      workspaceId: 'ws-7',
      checks: [sched('inspect', inspect)],
      runResult: { foo: 'bar' },
      toolCredentials: { salesforce: 'token' },
    })
    const c = captured as Record<string, unknown>
    expect(c.runId).toBe(runId)
    expect(c.workspaceId).toBe('ws-7')
    expect(c.runResult).toEqual({ foo: 'bar' })
    expect(c.toolCredentials).toEqual({ salesforce: 'token' })
  })
})

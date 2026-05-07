/**
 * auditWriter — Phase 05.
 *
 * Memory-impl tests covering the public record* functions, the step-index
 * allocator, idempotency around tool-call start/end pairs, and ordering of
 * the persisted timeline.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetForTests,
  __setRunStepRepoForTests,
  __setToolCallRepoForTests,
  createMemoryRunStepRepo,
  createMemoryToolCallRepo,
  listRunSteps,
  listToolCalls,
  nextStepIndex,
  recordApprovalStep,
  recordCheckStep,
  recordStepStart,
  recordToolCallEnd,
  recordToolCallStart,
  resetStepIndex,
} from './auditWriter.js'

beforeEach(() => {
  __setRunStepRepoForTests(createMemoryRunStepRepo())
  __setToolCallRepoForTests(createMemoryToolCallRepo())
})

afterEach(() => {
  __resetForTests()
  __setRunStepRepoForTests(null)
  __setToolCallRepoForTests(null)
})

describe('auditWriter — recordStepStart', () => {
  it('inserts a row, returns its stepId, and round-trips through listRunSteps', async () => {
    const { stepId } = await recordStepStart({
      runId: 'run-1',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: { text: 'Considering options.' },
    })
    expect(stepId).toBeTypeOf('string')
    expect(stepId.length).toBeGreaterThan(0)

    const steps = await listRunSteps('run-1')
    expect(steps).toHaveLength(1)
    expect(steps[0]!.stepId).toBe(stepId)
    expect(steps[0]!.kind).toBe('model_thinking')
    expect(steps[0]!.payload).toEqual({ text: 'Considering options.' })
    expect(steps[0]!.stepIndex).toBe(0)
    expect(steps[0]!.createdAt).toBeTypeOf('string')
  })

  it('preserves insertion-time stepIndex ordering across kinds', async () => {
    await recordStepStart({
      runId: 'run-2',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: { text: 'a' },
    })
    await recordStepStart({
      runId: 'run-2',
      stepIndex: 1,
      kind: 'model_tool_use',
      payload: { tool: 'computer' },
    })
    await recordStepStart({
      runId: 'run-2',
      stepIndex: 2,
      kind: 'tool_call',
      payload: { tool_name: 'computer.left_click' },
    })

    const steps = await listRunSteps('run-2')
    expect(steps.map((s) => s.kind)).toEqual([
      'model_thinking',
      'model_tool_use',
      'tool_call',
    ])
  })

  it('listRunSteps respects pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await recordStepStart({
        runId: 'run-3',
        stepIndex: i,
        kind: 'model_thinking',
        payload: { text: `chunk-${i}` },
      })
    }
    const page1 = await listRunSteps('run-3', 2, 0)
    expect(page1.map((s) => s.stepIndex)).toEqual([0, 1])
    const page2 = await listRunSteps('run-3', 2, 2)
    expect(page2.map((s) => s.stepIndex)).toEqual([2, 3])
  })

  it('isolates rows per run', async () => {
    await recordStepStart({
      runId: 'run-A',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: {},
    })
    await recordStepStart({
      runId: 'run-B',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: {},
    })
    expect(await listRunSteps('run-A')).toHaveLength(1)
    expect(await listRunSteps('run-B')).toHaveLength(1)
    expect(await listRunSteps('run-C')).toHaveLength(0)
  })
})

describe('auditWriter — recordApprovalStep / recordCheckStep', () => {
  it('recordApprovalStep persists with kind=approval', async () => {
    const { stepId } = await recordApprovalStep({
      runId: 'run-1',
      stepIndex: 5,
      payload: { approval_id: 'appr-x', tool_name: 'computer.left_click' },
    })
    expect(stepId).toBeTypeOf('string')
    const steps = await listRunSteps('run-1')
    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind).toBe('approval')
    expect(steps[0]!.payload).toMatchObject({ approval_id: 'appr-x' })
  })

  it('recordCheckStep persists with kind=check', async () => {
    await recordCheckStep({
      runId: 'run-1',
      stepIndex: 9,
      payload: { check_name: 'url_contains', passed: true },
    })
    const steps = await listRunSteps('run-1')
    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind).toBe('check')
    expect(steps[0]!.payload).toMatchObject({
      check_name: 'url_contains',
      passed: true,
    })
  })
})

describe('auditWriter — tool-call start/end pair', () => {
  it('insertStart returns null result + completedAt; updateEnd flips them', async () => {
    const { toolCallId } = await recordToolCallStart({
      runId: 'run-1',
      stepIndex: 0,
      toolName: 'computer.left_click',
      params: { coordinate: [10, 20] },
    })
    expect(toolCallId).toBeTypeOf('string')

    let calls = await listToolCalls('run-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.result).toBeNull()
    expect(calls[0]!.error).toBeNull()
    expect(calls[0]!.completedAt).toBeNull()
    expect(calls[0]!.startedAt).toBeTypeOf('string')

    await recordToolCallEnd({
      toolCallId,
      result: { content: [{ type: 'text', text: 'ok' }] },
      browserLatencyMs: 42,
    })

    calls = await listToolCalls('run-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(calls[0]!.browserLatencyMs).toBe(42)
    expect(calls[0]!.completedAt).toBeTypeOf('string')
  })

  it('updateEnd persists error text on failure path', async () => {
    const { toolCallId } = await recordToolCallStart({
      runId: 'run-2',
      stepIndex: 0,
      toolName: 'computer.left_click',
      params: {},
    })
    await recordToolCallEnd({
      toolCallId,
      error: 'boom',
      browserLatencyMs: 5,
    })
    const calls = await listToolCalls('run-2')
    expect(calls[0]!.error).toBe('boom')
  })

  it('updateEnd persists approvalId / trustGrantId / cost / latency', async () => {
    const { toolCallId } = await recordToolCallStart({
      runId: 'run-3',
      stepIndex: 0,
      toolName: 'computer.left_click',
      params: {},
    })
    await recordToolCallEnd({
      toolCallId,
      result: {},
      approvalId: 'appr-9',
      trustGrantId: 'grant-3',
      modelLatencyMs: 100,
      browserLatencyMs: 250,
      costCents: 7,
    })
    const [tc] = await listToolCalls('run-3')
    expect(tc!.approvalId).toBe('appr-9')
    expect(tc!.trustGrantId).toBe('grant-3')
    expect(tc!.modelLatencyMs).toBe(100)
    expect(tc!.browserLatencyMs).toBe(250)
    expect(tc!.costCents).toBe(7)
  })

  it('updateEnd on unknown toolCallId throws', async () => {
    await expect(
      recordToolCallEnd({ toolCallId: 'does-not-exist', error: 'x' }),
    ).rejects.toThrow(/tool call not found/)
  })

  it('listToolCalls returns calls in stepIndex order', async () => {
    const a = await recordToolCallStart({
      runId: 'run-4',
      stepIndex: 0,
      toolName: 'computer.screenshot',
      params: {},
    })
    const b = await recordToolCallStart({
      runId: 'run-4',
      stepIndex: 2,
      toolName: 'computer.left_click',
      params: {},
    })
    const c = await recordToolCallStart({
      runId: 'run-4',
      stepIndex: 1,
      toolName: 'computer.type',
      params: {},
    })
    const calls = await listToolCalls('run-4')
    expect(calls.map((tc) => tc.toolCallId)).toEqual([
      a.toolCallId,
      c.toolCallId,
      b.toolCallId,
    ])
  })

  it('listToolCalls respects limit + offset', async () => {
    for (let i = 0; i < 6; i++) {
      await recordToolCallStart({
        runId: 'run-5',
        stepIndex: i,
        toolName: 'computer.screenshot',
        params: { i },
      })
    }
    const page = await listToolCalls('run-5', 2, 2)
    expect(page).toHaveLength(2)
    expect(page.map((tc) => tc.stepIndex)).toEqual([2, 3])
  })
})

describe('auditWriter — step-index allocator', () => {
  it('nextStepIndex starts at 0 and increments per run', () => {
    expect(nextStepIndex('run-1')).toBe(0)
    expect(nextStepIndex('run-1')).toBe(1)
    expect(nextStepIndex('run-1')).toBe(2)
  })

  it('per-run counters are isolated', () => {
    expect(nextStepIndex('run-A')).toBe(0)
    expect(nextStepIndex('run-B')).toBe(0)
    expect(nextStepIndex('run-A')).toBe(1)
    expect(nextStepIndex('run-B')).toBe(1)
  })

  it('resetStepIndex drops a run from the counter map', () => {
    expect(nextStepIndex('run-x')).toBe(0)
    expect(nextStepIndex('run-x')).toBe(1)
    resetStepIndex('run-x')
    expect(nextStepIndex('run-x')).toBe(0)
  })
})

describe('auditWriter — memory repo isolation', () => {
  it('isolated step repos do not share state', async () => {
    const a = createMemoryRunStepRepo()
    const b = createMemoryRunStepRepo()
    await a.insert({
      runId: 'run-x',
      stepIndex: 0,
      kind: 'model_thinking',
      payload: {},
    })
    expect(await a.listByRun('run-x')).toHaveLength(1)
    expect(await b.listByRun('run-x')).toHaveLength(0)
  })

  it('isolated tool-call repos do not share state', async () => {
    const a = createMemoryToolCallRepo()
    const b = createMemoryToolCallRepo()
    await a.insertStart({
      runId: 'run-x',
      stepIndex: 0,
      toolName: 'computer.left_click',
      params: {},
    })
    expect(await a.listByRun('run-x')).toHaveLength(1)
    expect(await b.listByRun('run-x')).toHaveLength(0)
  })
})

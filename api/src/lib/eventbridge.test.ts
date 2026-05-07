/**
 * EventBridge schedule lifecycle helpers — Phase 10.5 unit tests.
 *
 * The AWS SDK is not exercised directly. We install a mock client
 * factory that captures every command sent to EventBridge and asserts
 * shape — no real network calls, no AWS creds needed.
 *
 * Coverage:
 *  - validateScheduleExpression: cron(...) / rate(...) accepted; bare
 *    cron / nonsense rejected with descriptive error.
 *  - upsertWorkflowSchedule:
 *      - no-op when EVENTBRIDGE_RULE_PREFIX is unset
 *      - PutRule + PutTargets when schedule set
 *      - DeleteRule when schedule cleared
 *      - State=DISABLED when workflow disabled
 *  - deleteWorkflowSchedule:
 *      - removes targets then rule
 *      - swallows ResourceNotFoundException
 *  - throws when prefix is set but ARN env vars missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetForTests,
  __setEventBridgeClientFactoryForTests,
  deleteWorkflowSchedule,
  isEventBridgeEnabled,
  ruleNameFor,
  upsertWorkflowSchedule,
  validateScheduleExpression,
} from './eventbridge.js'

// =============================================================================
// Mock client factory: every command sent through `client.send(cmd)` is
// recorded into `calls` for assertion. Optionally throws based on test
// configuration.
// =============================================================================

interface RecordedCall {
  command: string
  input: unknown
}

function makeMockClient(opts: {
  throwOn?: (cmd: { constructor: { name: string }; input: unknown }) => Error | null
} = {}) {
  const calls: RecordedCall[] = []
  const send = vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
    calls.push({ command: cmd.constructor.name, input: cmd.input })
    if (opts.throwOn) {
      const err = opts.throwOn(cmd)
      if (err) throw err
    }
    return {}
  })
  return {
    client: { send } as unknown as import('@aws-sdk/client-eventbridge').EventBridgeClient,
    calls,
    send,
  }
}

beforeEach(() => {
  delete process.env.EVENTBRIDGE_RULE_PREFIX
  delete process.env.EVENTBRIDGE_API_DESTINATION_ARN
  delete process.env.EVENTBRIDGE_TARGET_ROLE_ARN
  __resetForTests()
})

afterEach(() => {
  delete process.env.EVENTBRIDGE_RULE_PREFIX
  delete process.env.EVENTBRIDGE_API_DESTINATION_ARN
  delete process.env.EVENTBRIDGE_TARGET_ROLE_ARN
  __resetForTests()
})

// =============================================================================
// validateScheduleExpression.
// =============================================================================

describe('validateScheduleExpression', () => {
  it('accepts cron(...) with six fields', () => {
    expect(validateScheduleExpression('cron(0 9 ? * MON *)')).toBeNull()
    expect(validateScheduleExpression('cron(*/5 * * * ? *)')).toBeNull()
    expect(validateScheduleExpression('cron(0 0 1 1 ? *)')).toBeNull()
  })

  it('accepts rate(N unit)', () => {
    expect(validateScheduleExpression('rate(5 minutes)')).toBeNull()
    expect(validateScheduleExpression('rate(1 hour)')).toBeNull()
    expect(validateScheduleExpression('rate(7 days)')).toBeNull()
  })

  it('rejects bare 5-field cron (Linux-style)', () => {
    const err = validateScheduleExpression('0 9 * * 1')
    expect(err).not.toBeNull()
    expect(err).toContain('AWS EventBridge expression')
  })

  it('rejects empty / whitespace strings', () => {
    expect(validateScheduleExpression('')).not.toBeNull()
    expect(validateScheduleExpression('   ')).not.toBeNull()
  })

  it('rejects malformed wrappers', () => {
    expect(validateScheduleExpression('cron(0 9 ? * MON)')).not.toBeNull() // 5 fields
    expect(validateScheduleExpression('rate(5 fortnights)')).not.toBeNull()
    expect(validateScheduleExpression('schedule(*)')).not.toBeNull()
  })
})

// =============================================================================
// ruleNameFor.
// =============================================================================

describe('ruleNameFor', () => {
  it('combines prefix and id', () => {
    expect(ruleNameFor('abc-123', 'runtime-workflow-prod')).toBe(
      'runtime-workflow-prod-abc-123',
    )
  })
})

// =============================================================================
// no-op mode (no EVENTBRIDGE_RULE_PREFIX).
// =============================================================================

describe('no-op mode (prefix unset)', () => {
  it('isEventBridgeEnabled() reports false', () => {
    expect(isEventBridgeEnabled()).toBe(false)
  })

  it('upsertWorkflowSchedule resolves without sending any AWS commands', async () => {
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await upsertWorkflowSchedule({
      id: 'wf-1',
      workspaceId: 'ws-1',
      schedule: 'cron(0 9 ? * MON *)',
      enabled: true,
    })
    expect(mock.calls).toHaveLength(0)
  })

  it('deleteWorkflowSchedule resolves without sending any AWS commands', async () => {
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)
    await deleteWorkflowSchedule('wf-1')
    expect(mock.calls).toHaveLength(0)
  })
})

// =============================================================================
// Configuration validation.
// =============================================================================

describe('configuration validation', () => {
  it('throws when prefix is set but API destination ARN is missing', async () => {
    process.env.EVENTBRIDGE_RULE_PREFIX = 'test-pfx'
    process.env.EVENTBRIDGE_TARGET_ROLE_ARN = 'arn:aws:iam::1:role/x'
    // EVENTBRIDGE_API_DESTINATION_ARN intentionally unset
    await expect(
      upsertWorkflowSchedule({
        id: 'wf',
        workspaceId: 'ws',
        schedule: 'rate(5 minutes)',
        enabled: true,
      }),
    ).rejects.toThrow(/EVENTBRIDGE_API_DESTINATION_ARN/)
  })

  it('throws when prefix is set but role ARN is missing', async () => {
    process.env.EVENTBRIDGE_RULE_PREFIX = 'test-pfx'
    process.env.EVENTBRIDGE_API_DESTINATION_ARN = 'arn:aws:events:::api-destination/x'
    // EVENTBRIDGE_TARGET_ROLE_ARN intentionally unset
    await expect(
      upsertWorkflowSchedule({
        id: 'wf',
        workspaceId: 'ws',
        schedule: 'rate(5 minutes)',
        enabled: true,
      }),
    ).rejects.toThrow(/EVENTBRIDGE_TARGET_ROLE_ARN/)
  })
})

// =============================================================================
// upsertWorkflowSchedule (live mode).
// =============================================================================

function configureLiveEnv() {
  process.env.EVENTBRIDGE_RULE_PREFIX = 'runtime-workflow-test'
  process.env.EVENTBRIDGE_API_DESTINATION_ARN =
    'arn:aws:events:us-east-1:123:api-destination/runtime-runnow/abc'
  process.env.EVENTBRIDGE_TARGET_ROLE_ARN =
    'arn:aws:iam::123:role/runtime-eventbridge'
  process.env.AWS_REGION = 'us-east-1'
}

describe('upsertWorkflowSchedule', () => {
  it('PutRule + PutTargets for an enabled workflow', async () => {
    configureLiveEnv()
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await upsertWorkflowSchedule({
      id: 'wf-abc',
      workspaceId: 'ws-1',
      schedule: 'cron(0 9 ? * MON *)',
      enabled: true,
    })

    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[0]!.command).toBe('PutRuleCommand')
    const putRule = mock.calls[0]!.input as Record<string, unknown>
    expect(putRule.Name).toBe('runtime-workflow-test-wf-abc')
    expect(putRule.ScheduleExpression).toBe('cron(0 9 ? * MON *)')
    expect(putRule.State).toBe('ENABLED')

    expect(mock.calls[1]!.command).toBe('PutTargetsCommand')
    const putTargets = mock.calls[1]!.input as {
      Rule: string
      Targets: Array<{
        Arn: string
        RoleArn: string
        HttpParameters?: { PathParameterValues: string[] }
        Input: string
      }>
    }
    expect(putTargets.Rule).toBe('runtime-workflow-test-wf-abc')
    expect(putTargets.Targets).toHaveLength(1)
    expect(putTargets.Targets[0]!.Arn).toBe(
      'arn:aws:events:us-east-1:123:api-destination/runtime-runnow/abc',
    )
    expect(putTargets.Targets[0]!.RoleArn).toBe(
      'arn:aws:iam::123:role/runtime-eventbridge',
    )
    expect(putTargets.Targets[0]!.HttpParameters?.PathParameterValues).toEqual([
      'wf-abc',
    ])
    const inputBody = JSON.parse(putTargets.Targets[0]!.Input) as Record<
      string,
      unknown
    >
    expect(inputBody.workflow_id).toBe('wf-abc')
    expect(inputBody.workspace_id).toBe('ws-1')
    expect(inputBody.source).toBe('eventbridge')
  })

  it('PutRule with State=DISABLED when workflow is disabled', async () => {
    configureLiveEnv()
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await upsertWorkflowSchedule({
      id: 'wf-paused',
      workspaceId: 'ws-1',
      schedule: 'rate(15 minutes)',
      enabled: false,
    })
    const putRule = mock.calls[0]!.input as Record<string, unknown>
    expect(putRule.State).toBe('DISABLED')
  })

  it('clears the rule when schedule is null (delegates to delete)', async () => {
    configureLiveEnv()
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await upsertWorkflowSchedule({
      id: 'wf-cleared',
      workspaceId: 'ws-1',
      schedule: null,
      enabled: true,
    })

    // RemoveTargets, then DeleteRule. No PutRule / PutTargets.
    const commands = mock.calls.map((c) => c.command)
    expect(commands).toEqual(['RemoveTargetsCommand', 'DeleteRuleCommand'])
  })
})

// =============================================================================
// deleteWorkflowSchedule.
// =============================================================================

describe('deleteWorkflowSchedule', () => {
  it('issues RemoveTargets then DeleteRule with the deterministic name', async () => {
    configureLiveEnv()
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await deleteWorkflowSchedule('wf-doomed')

    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[0]!.command).toBe('RemoveTargetsCommand')
    expect(
      (mock.calls[0]!.input as { Rule: string }).Rule,
    ).toBe('runtime-workflow-test-wf-doomed')
    expect(mock.calls[1]!.command).toBe('DeleteRuleCommand')
    expect(
      (mock.calls[1]!.input as { Name: string }).Name,
    ).toBe('runtime-workflow-test-wf-doomed')
  })

  it('swallows ResourceNotFoundException on RemoveTargets and proceeds', async () => {
    configureLiveEnv()
    const notFound = Object.assign(new Error('rule not found'), {
      name: 'ResourceNotFoundException',
    })
    let removeCalled = false
    const mock = makeMockClient({
      throwOn: (cmd) => {
        if (cmd.constructor.name === 'RemoveTargetsCommand' && !removeCalled) {
          removeCalled = true
          return notFound
        }
        return null
      },
    })
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await deleteWorkflowSchedule('wf-already-gone')
    // Both calls happen; no throw.
    const commands = mock.calls.map((c) => c.command)
    expect(commands).toEqual(['RemoveTargetsCommand', 'DeleteRuleCommand'])
  })

  it('swallows ResourceNotFoundException on DeleteRule', async () => {
    configureLiveEnv()
    const notFound = Object.assign(new Error('rule not found'), {
      name: 'ResourceNotFoundException',
    })
    const mock = makeMockClient({
      throwOn: (cmd) =>
        cmd.constructor.name === 'DeleteRuleCommand' ? notFound : null,
    })
    __setEventBridgeClientFactoryForTests(() => mock.client)

    await expect(
      deleteWorkflowSchedule('wf-already-gone'),
    ).resolves.toBeUndefined()
  })
})

// =============================================================================
// Lifecycle integration with workflowsRepo (via the workflows route).
// We verify that create/patch/delete fire upsert/delete via a captured
// client.
// =============================================================================

describe('workflows route → eventbridge lifecycle integration', () => {
  it('creating a workflow with a schedule triggers PutRule', async () => {
    configureLiveEnv()
    const mock = makeMockClient()
    __setEventBridgeClientFactoryForTests(() => mock.client)

    // Set up the same minimal env the workflows.test.ts uses.
    process.env.NODE_ENV = 'test'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
    process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
    process.env.GEMINI_API_KEY = 'test-gemini'

    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const wf = await import('../orchestrator/workflowsRepo.js')
    wf.__setWorkflowsRepoForTests(wf.createMemoryRepo())
    const { buildApp } = await import('../app.js')
    const app = buildApp()

    const { signWorkspaceToken } = await import('./jwt.js')
    const issued = new Date()
    const expires = new Date(issued.getTime() + 3600_000)
    const token = await signWorkspaceToken({
      workspace_id: 'ws-evb',
      account_id: 'acct',
      plan: 'free',
      seat_status: 'active',
      issued_at: issued.toISOString(),
      expires_at: expires.toISOString(),
    })

    const res = await app.request('/v1/runtime/workflows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': token,
      },
      body: JSON.stringify({
        name: 'A',
        prompt: 'p',
        schedule: 'rate(5 minutes)',
      }),
    })
    expect(res.status).toBe(201)

    const commands = mock.calls.map((c) => c.command)
    expect(commands).toContain('PutRuleCommand')
    expect(commands).toContain('PutTargetsCommand')
  })
})

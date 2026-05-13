import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @basics/shared (the api workspace can't always resolve it at vitest-load time).
vi.mock('@basics/shared', () => ({
  ComposioClient: class {
    constructor() {}
  },
  ComposioUnavailableError: class extends Error {
    constructor(m?: string) {
      super(m)
      this.name = 'ComposioUnavailableError'
    }
  },
}))

// Mock SchedulerClient before importing the registry.
const schedulerSendMock = vi.fn(async (cmd: unknown) => {
  const ctor = (cmd as { constructor: { name: string } }).constructor.name
  if (ctor === 'CreateScheduleCommand')
    return { ScheduleArn: 'arn:aws:scheduler:us-east-1:000:schedule/default/test' }
  if (ctor === 'DeleteScheduleCommand') return {}
  if (ctor === 'UpdateScheduleCommand') return {}
  return {}
})
class CreateScheduleCommand {
  input: unknown
  constructor(i: unknown) {
    this.input = i
  }
}
class DeleteScheduleCommand {
  input: unknown
  constructor(i: unknown) {
    this.input = i
  }
}
class UpdateScheduleCommand {
  input: unknown
  constructor(i: unknown) {
    this.input = i
  }
}
class ConflictExceptionImpl extends Error {
  override readonly name = 'ConflictException'
}
class ResourceNotFoundExceptionImpl extends Error {
  override readonly name = 'ResourceNotFoundException'
}
vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class {
    send = schedulerSendMock
  },
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
  ConflictException: ConflictExceptionImpl,
  ResourceNotFoundException: ResourceNotFoundExceptionImpl,
}))

interface ExecCall {
  query: string
}
const dbCalls: ExecCall[] = []
const dbResponses: unknown[][] = []
vi.mock('../db/index.js', () => ({
  db: {
    execute: vi.fn(async (sqlObj: unknown) => {
      let stringified: string
      try {
        stringified = JSON.stringify(sqlObj)
      } catch {
        stringified = String(sqlObj)
      }
      dbCalls.push({ query: stringified })
      return dbResponses.shift() ?? []
    }),
  },
}))

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test'
  process.env.CRON_KICKER_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:000:function:basics-cron-kicker'
  process.env.SCHEDULER_INVOKE_ROLE_ARN = 'arn:aws:iam::000:role/basics-scheduler-invoke-production'
})

beforeEach(() => {
  vi.resetModules()
  schedulerSendMock.mockClear()
  dbCalls.length = 0
  dbResponses.length = 0
})

const AID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('reconcileTriggers', () => {
  it('no-ops when prior == next', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests(null)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [{ type: 'manual' }],
      nextTriggers: [{ type: 'manual' }],
      composioUserId: 'ws',
      connectedAccountByToolkit: {},
    })
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(schedulerSendMock).not.toHaveBeenCalled()
  })

  it('adds a schedule trigger via CreateScheduleCommand', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests(null)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [],
      nextTriggers: [
        { type: 'schedule', cron: '0 9 * * MON-FRI', timezone: 'America/Los_Angeles' },
      ],
      composioUserId: 'ws',
      connectedAccountByToolkit: {},
    })
    expect(result.added).toHaveLength(1)
    expect(result.added[0]!.kind).toBe('schedule')
    expect(result.added[0]!.ref).toBe(`automation-${AID}-0`)
    expect(schedulerSendMock).toHaveBeenCalledTimes(1)
    const sentCmd = schedulerSendMock.mock.calls[0]![0] as {
      constructor: { name: string }
      input: { ScheduleExpression: string; ScheduleExpressionTimezone?: string }
    }
    expect(sentCmd.constructor.name).toBe('CreateScheduleCommand')
    // EventBridge requires 6-field cron with ? in dom when dow is set.
    expect(sentCmd.input.ScheduleExpression).toBe('cron(0 9 ? * MON-FRI *)')
    expect(sentCmd.input.ScheduleExpressionTimezone).toBe('America/Los_Angeles')
  })

  it('removes a schedule trigger via DeleteScheduleCommand', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests(null)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [
        { type: 'schedule', cron: '0 9 * * MON-FRI', timezone: 'America/Los_Angeles' },
      ],
      nextTriggers: [],
      composioUserId: 'ws',
      connectedAccountByToolkit: {},
    })
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0]!.kind).toBe('schedule')
    expect(schedulerSendMock).toHaveBeenCalledTimes(1)
    expect(
      (schedulerSendMock.mock.calls[0]![0] as { constructor: { name: string } }).constructor.name,
    ).toBe('DeleteScheduleCommand')
  })

  it('one-shot schedule produces at(...) expression', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests(null)
    await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [],
      nextTriggers: [{ type: 'schedule', at: '2026-06-01T09:00:00Z' }],
      composioUserId: 'ws',
      connectedAccountByToolkit: {},
    })
    const sentCmd = schedulerSendMock.mock.calls[0]![0] as { input: { ScheduleExpression: string } }
    expect(sentCmd.input.ScheduleExpression).toMatch(/^at\(2026-06-01T09:00:00\)$/)
  })

  it('composio_webhook with no connected account → warning, no DB write', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests({
      createTrigger: vi.fn(),
      deleteTrigger: vi.fn(),
    } as never)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [],
      nextTriggers: [{ type: 'composio_webhook', toolkit: 'GMAIL', event: 'message_received' }],
      composioUserId: 'ws',
      connectedAccountByToolkit: {},
    })
    expect(result.added).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.message).toContain('no_connected_account_for_toolkit=GMAIL')
  })

  it('composio_webhook happy path calls createTrigger + INSERTs composio_triggers row', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    const createTriggerMock = vi.fn(async () => ({ triggerId: 'comp_trig_123', raw: {} }))
    setComposioClientForTests({
      createTrigger: createTriggerMock,
      deleteTrigger: vi.fn(),
    } as never)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [],
      nextTriggers: [
        {
          type: 'composio_webhook',
          toolkit: 'GMAIL',
          event: 'message_received',
          filters: { from: 'x@y.com' },
        },
      ],
      composioUserId: 'ws',
      connectedAccountByToolkit: { gmail: 'cac_abc' },
    })
    expect(result.added).toHaveLength(1)
    expect(result.added[0]!.ref).toBe('comp_trig_123')
    expect(createTriggerMock).toHaveBeenCalledOnce()
    const call = (
      createTriggerMock.mock.calls[0] as unknown as [
        { toolkit: string; connectedAccountId: string; filters?: unknown },
      ]
    )[0]
    expect(call.toolkit).toBe('GMAIL')
    expect(call.connectedAccountId).toBe('cac_abc')
    expect(call.filters).toEqual({ from: 'x@y.com' })
    expect(dbCalls.some((c) => c.query.includes('composio_triggers'))).toBe(true)
  })

  it('composio API failure surfaces as a warning (non-fatal)', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests({
      createTrigger: vi.fn(async () => {
        throw new Error('Composio /triggers failed with HTTP 500')
      }),
      deleteTrigger: vi.fn(),
    } as never)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [],
      nextTriggers: [{ type: 'composio_webhook', toolkit: 'GMAIL', event: 'message_received' }],
      composioUserId: 'ws',
      connectedAccountByToolkit: { gmail: 'cac_abc' },
    })
    expect(result.added).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.message).toContain('composio createTrigger failed')
  })

  it('schedule + composio combined: both fire, both indexed correctly', async () => {
    const { reconcileTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    setComposioClientForTests({
      createTrigger: vi.fn(async () => ({ triggerId: 'comp_combined', raw: {} })),
      deleteTrigger: vi.fn(),
    } as never)
    const result = await reconcileTriggers({
      workspaceId: 'ws',
      accountId: 'acc',
      automationId: AID,
      goal: 'g',
      priorTriggers: [],
      nextTriggers: [
        { type: 'composio_webhook', toolkit: 'GMAIL', event: 'message_received' },
        { type: 'schedule', cron: '*/30 * * * ? *', timezone: 'UTC' },
      ],
      composioUserId: 'ws',
      connectedAccountByToolkit: { gmail: 'cac_abc' },
    })
    expect(result.added).toHaveLength(2)
    expect(result.added.map((a) => a.kind).sort()).toEqual(['composio_webhook', 'schedule'])
    expect(result.added.find((a) => a.kind === 'composio_webhook')!.ref).toBe('comp_combined')
    expect(result.added.find((a) => a.kind === 'schedule')!.ref).toBe(`automation-${AID}-1`)
  })
})

describe('teardownAllTriggers', () => {
  it('removes all schedule + composio triggers for an automation', async () => {
    const { teardownAllTriggers, setComposioClientForTests } =
      await import('./automation-trigger-registry.js')
    dbResponses.push([{ id: 'row_uuid', composio_trigger_id: 'comp_to_delete' }])
    const deleteTriggerMock = vi.fn(async () => undefined)
    setComposioClientForTests({
      createTrigger: vi.fn(),
      deleteTrigger: deleteTriggerMock,
    } as never)
    const result = await teardownAllTriggers(AID, [
      { type: 'composio_webhook', toolkit: 'GMAIL', event: 'message_received' },
      { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' },
    ])
    expect(result.removed.length).toBeGreaterThan(0)
    expect(deleteTriggerMock).toHaveBeenCalledWith('comp_to_delete')
    // DeleteScheduleCommand fired.
    expect(
      schedulerSendMock.mock.calls.some(
        (c) =>
          (c[0] as { constructor: { name: string } }).constructor.name === 'DeleteScheduleCommand',
      ),
    ).toBe(true)
  })
})

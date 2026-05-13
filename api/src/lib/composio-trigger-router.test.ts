import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the SQS SDK first.
const sqsSendMock = vi.fn(async (_cmd: unknown) => ({ MessageId: 'mock-msg' }))
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = sqsSendMock },
  SendMessageCommand: class { input: unknown; constructor(i: unknown) { this.input = i } },
}))

interface ExecCall { query: string }
const dbCalls: ExecCall[] = []
const dbResponses: unknown[][] = []
vi.mock('../db/index.js', () => ({
  db: {
    execute: vi.fn(async (sqlObj: unknown) => {
      let stringified: string
      try { stringified = JSON.stringify(sqlObj) } catch { stringified = String(sqlObj) }
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
  process.env.RUNS_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/basics-runs.fifo'
})

beforeEach(() => {
  vi.resetModules()
  sqsSendMock.mockClear()
  dbCalls.length = 0
  dbResponses.length = 0
})

const TRIGGER_ROW = {
  id: 'trig_row_uuid',
  automation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  toolkit: 'gmail',
  event_type: 'GMAIL_NEW_GMAIL_MESSAGE',
  filters: null,
}
const AUTOMATION_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspace_id: 'ws_uuid',
  goal: 'process new emails',
  version: 1,
  archived_at: null,
}

const TRIGGER_MESSAGE_PAYLOAD = {
  type: 'composio.trigger.message',
  id: 'evt_xxx',
  metadata: { trigger_id: 'ti_abc123', connected_account_id: 'ca_def456' },
  data: { messageId: 'msg_xyz', subject: 'hello' },
}

describe('routeTriggerMessage', () => {
  it('no trigger_id in payload → not_routed', async () => {
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    const result = await routeTriggerMessage({ type: 'composio.trigger.message', data: {} })
    expect(result.routed).toBe(false)
    expect(result.reason).toBe('no_trigger_id')
    expect(dbCalls).toHaveLength(0)
  })

  it('trigger not registered → not_routed (1 lookup, no insert)', async () => {
    dbResponses.push([])  // composio_triggers SELECT empty
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    const result = await routeTriggerMessage(TRIGGER_MESSAGE_PAYLOAD)
    expect(result.routed).toBe(false)
    expect(result.reason).toBe('trigger_not_registered')
    expect(dbCalls).toHaveLength(1)
  })

  it('automation archived → not_routed', async () => {
    dbResponses.push([TRIGGER_ROW])
    dbResponses.push([{ ...AUTOMATION_ROW, archived_at: new Date().toISOString() }])
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    const result = await routeTriggerMessage(TRIGGER_MESSAGE_PAYLOAD)
    expect(result.routed).toBe(false)
    expect(result.reason).toBe('automation_not_active')
  })

  it('no active workspace member → not_routed', async () => {
    dbResponses.push([TRIGGER_ROW])
    dbResponses.push([AUTOMATION_ROW])
    dbResponses.push([])  // no workspace_members rows
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    const result = await routeTriggerMessage(TRIGGER_MESSAGE_PAYLOAD)
    expect(result.routed).toBe(false)
    expect(result.reason).toBe('no_workspace_member')
  })

  it('happy path: GMAIL message → inputs.email, INSERT trigger_event_log + cloud_runs + SQS', async () => {
    dbResponses.push([TRIGGER_ROW])                     // composio_triggers lookup
    dbResponses.push([AUTOMATION_ROW])                  // automations lookup
    dbResponses.push([{ account_id: 'acc_uuid' }])      // workspace_members
    dbResponses.push([])                                // INSERT trigger_event_log
    dbResponses.push([{ id: 'cag_uuid' }])              // SELECT ad-hoc cloud_agents (exists)
    dbResponses.push([])                                // INSERT cloud_runs
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    const result = await routeTriggerMessage(TRIGGER_MESSAGE_PAYLOAD)
    expect(result.routed).toBe(true)
    expect(result.runId).toMatch(/^[0-9a-f]{8}-/)
    expect(result.automationId).toBe(AUTOMATION_ROW.id)
    expect(result.triggerEventLogId).toMatch(/^[0-9a-f]{8}-/)

    // Asserts on the DB calls.
    expect(dbCalls).toHaveLength(6)
    expect(dbCalls[3]!.query).toContain('trigger_event_log')
    expect(dbCalls[5]!.query).toContain('cloud_runs')
    expect(dbCalls[5]!.query).toContain('composio_webhook')

    // SQS dispatch with the gmail mapper inputs.
    expect(sqsSendMock).toHaveBeenCalledOnce()
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string; MessageGroupId: string } }
    expect(sent.input.MessageGroupId).toBe('ws_uuid')
    const body = JSON.parse(sent.input.MessageBody) as Record<string, unknown>
    expect(body.triggeredBy).toBe('composio_webhook')
    expect(body.inputs).toEqual({ email: { messageId: 'msg_xyz', subject: 'hello' } })
    expect(body.automationId).toBe(AUTOMATION_ROW.id)
  })

  it('creates ad-hoc cloud_agent when missing', async () => {
    dbResponses.push([TRIGGER_ROW])
    dbResponses.push([AUTOMATION_ROW])
    dbResponses.push([{ account_id: 'acc_uuid' }])
    dbResponses.push([])                               // INSERT trigger_event_log
    dbResponses.push([])                               // SELECT cloud_agents — empty
    dbResponses.push([{ id: 'cag_created' }])          // INSERT cloud_agents RETURNING
    dbResponses.push([])                               // INSERT cloud_runs
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    const result = await routeTriggerMessage(TRIGGER_MESSAGE_PAYLOAD)
    expect(result.routed).toBe(true)
    expect(dbCalls).toHaveLength(7)
    expect(dbCalls[5]!.query).toContain('INSERT INTO public.cloud_agents')
  })

  it('Google Sheets row mapper produces inputs.row', async () => {
    dbResponses.push([{ ...TRIGGER_ROW, toolkit: 'googlesheets', event_type: 'GOOGLESHEETS_NEW_ROW' }])
    dbResponses.push([AUTOMATION_ROW])
    dbResponses.push([{ account_id: 'acc_uuid' }])
    dbResponses.push([])
    dbResponses.push([{ id: 'cag' }])
    dbResponses.push([])
    const { routeTriggerMessage } = await import('./composio-trigger-router.js')
    await routeTriggerMessage({
      type: 'composio.trigger.message',
      metadata: { trigger_id: 'ti_abc', connected_account_id: 'ca_def' },
      data: { row: { Name: 'Acme', Stage: 'Pipeline' } },
    })
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string } }
    const body = JSON.parse(sent.input.MessageBody) as Record<string, unknown>
    expect(body.inputs).toEqual({ row: { Name: 'Acme', Stage: 'Pipeline' } })
  })
})

describe('emitConnectionExpiredEvent', () => {
  it('emits cloud_activity row into the latest open run', async () => {
    dbResponses.push([{ id: 'run_uuid', workspace_id: 'ws', account_id: 'acc' }])
    dbResponses.push([])  // INSERT cloud_activity
    const { emitConnectionExpiredEvent } = await import('./composio-trigger-router.js')
    const result = await emitConnectionExpiredEvent('ca_expired')
    expect(result.emitted).toBe(true)
    expect(result.runId).toBe('run_uuid')
    expect(dbCalls[1]!.query).toContain('connection_expired')
    expect(dbCalls[1]!.query).toContain('ca_expired')
  })

  it('no open run → emitted=false (graceful)', async () => {
    dbResponses.push([])
    const { emitConnectionExpiredEvent } = await import('./composio-trigger-router.js')
    const result = await emitConnectionExpiredEvent('ca_expired')
    expect(result.emitted).toBe(false)
    expect(dbCalls).toHaveLength(1)
  })
})

describe('internal pickers', () => {
  it('pickTriggerId pulls from metadata.trigger_id', async () => {
    const { _internals } = await import('./composio-trigger-router.js')
    expect(_internals.pickTriggerId({ metadata: { trigger_id: 'ti_x' } })).toBe('ti_x')
  })
  it('pickTriggerId falls back to top-level trigger_id', async () => {
    const { _internals } = await import('./composio-trigger-router.js')
    expect(_internals.pickTriggerId({ trigger_id: 'ti_top' })).toBe('ti_top')
  })
  it('pickInputMapper routes gmail → email key', async () => {
    const { _internals } = await import('./composio-trigger-router.js')
    expect(_internals.pickInputMapper('gmail', 'GMAIL_NEW_GMAIL_MESSAGE')({ x: 1 })).toEqual({ email: { x: 1 } })
  })
  it('pickInputMapper routes googlesheets → row key', async () => {
    const { _internals } = await import('./composio-trigger-router.js')
    expect(_internals.pickInputMapper('googlesheets', 'GOOGLESHEETS_NEW_ROW')({ row: { A: 1 } })).toEqual({ row: { A: 1 } })
  })
  it('pickInputMapper unknown toolkit → default {event:...}', async () => {
    const { _internals } = await import('./composio-trigger-router.js')
    expect(_internals.pickInputMapper('unknown', 'X')({ a: 1 })).toEqual({ event: { a: 1 } })
  })
})

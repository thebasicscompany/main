import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sqsSendMock = vi.fn(async (_cmd: unknown) => ({ MessageId: 'mock-msg-id' }))
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = sqsSendMock },
  SendMessageCommand: class {
    input: unknown
    constructor(input: unknown) { this.input = input }
  },
}))

const grantDeepgramTokenMock = vi.fn(async () => ({
  deepgramToken: 'dg-token',
  sttUrl: 'wss://api.deepgram.com/v1/listen',
  ttsUrl: 'https://api.deepgram.com/v1/speak',
  expiresIn: 3600,
}))
vi.mock('../lib/deepgram.js', () => ({
  grantDeepgramToken: grantDeepgramTokenMock,
}))

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'
const TEST_CLOUD_AGENT_ID = '22222222-2222-4222-8222-222222222222'
const TEST_LANE_ID = '33333333-3333-4333-8333-333333333333'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test'
  process.env.RUNS_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/basics-runs.fifo'
})

beforeEach(() => {
  vi.resetModules()
  sqsSendMock.mockClear()
  grantDeepgramTokenMock.mockClear()
})

interface ExecCall {
  query: string
}

async function freshApp(responses: unknown[][]) {
  const calls: ExecCall[] = []
  let i = 0
  vi.doMock('../db/index.js', () => ({
    db: {
      execute: vi.fn(async (sqlObj: unknown) => {
        let stringified: string
        try {
          stringified = JSON.stringify(sqlObj)
        } catch {
          stringified = String(sqlObj)
        }
        calls.push({ query: stringified })
        const out = responses[i] ?? []
        i++
        return out
      }),
    },
  }))

  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()

  const { buildApp } = await import('../app.js')
  return { app: buildApp(), calls }
}

async function signTestToken(workspaceId = TEST_WORKSPACE_ID, accountId = TEST_ACCOUNT_ID) {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: accountId,
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

describe('POST /v1/voice/credentials', () => {
  it('requires workspace JWT', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/voice/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('returns scoped Deepgram credentials', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/voice/credentials', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': await signTestToken(),
      },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.deepgramToken).toBe('dg-token')
    expect(grantDeepgramTokenMock).toHaveBeenCalledWith(expect.any(String), TEST_WORKSPACE_ID)
  })
})

describe('POST /v1/voice/runs', () => {
  it('400s on empty transcript', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/v1/voice/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': await signTestToken(),
      },
      body: JSON.stringify({ transcript: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(sqsSendMock).not.toHaveBeenCalled()
  })

  it('inserts cloud_runs and dispatches a voice prompt to SQS', async () => {
    const { app, calls } = await freshApp([
      [{ id: TEST_CLOUD_AGENT_ID }],
      [],
    ])
    const res = await app.request('/v1/voice/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': await signTestToken(),
      },
      body: JSON.stringify({
        transcript: 'Run the weekly RevOps digest for this account.',
        screenContext: { app: 'Salesforce', title: 'Acme account', facts: ['open renewal'] },
        laneId: TEST_LANE_ID,
        conversationId: 'voice-conv-1',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.runId).toMatch(/^[0-9a-f]{8}-/)
    expect(body.status).toBe('pending')
    expect(body.cloudAgentId).toBe(TEST_CLOUD_AGENT_ID)
    expect(body.eventsUrl).toBe(`/v1/runs/${body.runId}/events`)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.query).toContain('cloud_agents')
    expect(calls[1]!.query).toContain('cloud_runs')
    expect(sqsSendMock).toHaveBeenCalledTimes(1)
    const sentInput = sqsSendMock.mock.calls[0]![0] as {
      input: { MessageBody: string; MessageGroupId: string }
    }
    expect(sentInput.input.MessageGroupId).toBe(`${TEST_WORKSPACE_ID}:${TEST_LANE_ID}`)
    const sentBody = JSON.parse(sentInput.input.MessageBody) as Record<string, unknown>
    expect(sentBody.runId).toBe(body.runId)
    expect(sentBody.workspaceId).toBe(TEST_WORKSPACE_ID)
    expect(sentBody.accountId).toBe(TEST_ACCOUNT_ID)
    expect(sentBody.goal).toContain('This run was started by voice from the Double overlay.')
    expect(sentBody.goal).toContain('VOICE REQUEST:')
    expect(sentBody.goal).toContain('Run the weekly RevOps digest')
    expect(sentBody.goal).toContain('SCREEN CONTEXT:')
    expect(sentBody.goal).toContain('Salesforce')
    expect(sentBody.goal).toContain('Ask for approval before external writes')
  })

  it('404s when an explicit cloudAgentId is outside the workspace', async () => {
    const { app } = await freshApp([[]])
    const res = await app.request('/v1/voice/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workspace-Token': await signTestToken(),
      },
      body: JSON.stringify({
        transcript: 'Do the thing.',
        cloudAgentId: TEST_CLOUD_AGENT_ID,
      }),
    })
    expect(res.status).toBe(404)
    expect(sqsSendMock).not.toHaveBeenCalled()
  })
})

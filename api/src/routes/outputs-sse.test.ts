import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'
const TEST_RUN_ID = '11111111-1111-4111-8111-111111111111'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test'
})

beforeEach(() => {
  vi.resetModules()
})

interface ChannelMock {
  listeners: Record<string, (payload: { new?: unknown }) => Promise<void>>
  removed: boolean
}

function makeMockSupabase(channel: ChannelMock): unknown {
  return {
    channel: () => {
      const builder: Record<string, unknown> = {}
      builder.on = (
        _kind: string,
        cfg: { event: string },
        cb: (payload: { new?: unknown }) => Promise<void>,
      ) => {
        channel.listeners[cfg.event] = cb
        return builder
      }
      builder.subscribe = () => builder
      return builder
    },
    removeChannel: async () => {
      channel.removed = true
    },
  }
}

async function freshApp() {
  const channel: ChannelMock = { listeners: {}, removed: false }
  const { Hono } = await import('hono')
  const { requireWorkspaceJwt } = await import('../middleware/jwt.js')
  const { outputsSseRoute, setSupabaseFactoryForOutputsTests } = await import('./outputs-sse.js')
  setSupabaseFactoryForOutputsTests(() => makeMockSupabase(channel) as never)
  const app = new Hono()
  app.use('/v1/workspaces', requireWorkspaceJwt)
  app.use('/v1/workspaces/*', requireWorkspaceJwt)
  app.route('/v1/workspaces', outputsSseRoute)
  return { app, channel }
}

async function signTestToken(workspaceId = TEST_WORKSPACE_ID) {
  const { signWorkspaceToken } = await import('../lib/jwt.js')
  const issued = new Date()
  const expires = new Date(issued.getTime() + 3600_000)
  return signWorkspaceToken({
    workspace_id: workspaceId,
    account_id: TEST_ACCOUNT_ID,
    plan: 'free',
    seat_status: 'active',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
  })
}

async function fireAndCapture(
  channel: ChannelMock,
  res: Response,
  payload: { new?: unknown },
  deadlineMs = 2_000,
): Promise<Array<{ event?: string; data?: string }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Array<{ event?: string; data?: string }> = []
  let buf = ''
  let fired = false
  const deadline = Date.now() + deadlineMs

  while (Date.now() < deadline) {
    if (
      !fired &&
      channel.listeners.INSERT &&
      frames.some((f) => f.event === 'ready')
    ) {
      fired = true
      await channel.listeners.INSERT!(payload)
    }
    if (frames.some((f) => f.event === 'output')) break

    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((res2) =>
        setTimeout(() => res2({ value: undefined, done: true }), 30),
      ),
    ])
    if (done) break
    if (!value) continue
    buf += decoder.decode(value, { stream: true })
    while (true) {
      const idx = buf.indexOf('\n\n')
      if (idx === -1) break
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (raw.startsWith(':')) continue
      const f: { event?: string; data?: string } = {}
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) f.event = line.slice(6).trim()
        else if (line.startsWith('data:')) f.data = line.slice(5).trim()
      }
      frames.push(f)
    }
  }
  reader.cancel().catch(() => undefined)
  return frames
}

async function fireAndExpectNoOutput(
  channel: ChannelMock,
  res: Response,
  payload: { new?: unknown },
  deadlineMs = 500,
): Promise<Array<{ event?: string; data?: string }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Array<{ event?: string; data?: string }> = []
  let buf = ''
  let fired = false
  const deadline = Date.now() + deadlineMs

  while (Date.now() < deadline) {
    if (!fired && channel.listeners.INSERT && frames.some((f) => f.event === 'ready')) {
      fired = true
      await channel.listeners.INSERT!(payload)
    }
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((res2) =>
        setTimeout(() => res2({ value: undefined, done: true }), 30),
      ),
    ])
    if (done) break
    if (!value) continue
    buf += decoder.decode(value, { stream: true })
    while (true) {
      const idx = buf.indexOf('\n\n')
      if (idx === -1) break
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (raw.startsWith(':')) continue
      const f: { event?: string; data?: string } = {}
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) f.event = line.slice(6).trim()
        else if (line.startsWith('data:')) f.data = line.slice(5).trim()
      }
      frames.push(f)
    }
  }
  reader.cancel().catch(() => undefined)
  return frames
}

// ---------------------------------------------------------------------------

describe('GET /v1/workspaces/:wsId/outputs/stream', () => {
  it('rejects request with no auth → 401', async () => {
    const { app } = await freshApp()
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/outputs/stream`, {
      method: 'GET',
    })
    expect(res.status).toBe(401)
  })

  it('rejects path workspace mismatch → 403', async () => {
    const { app } = await freshApp()
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${OTHER_WORKSPACE_ID}/outputs/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
  })

  it('emits a ready frame on connect, then forwards output_dispatched (production payload shape) as event: output', async () => {
    const { app, channel } = await freshApp()
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/outputs/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)

    // Mirror the REAL OutputDispatchedEventSchema in shared/src/activity.ts:
    //   { kind, channel, recipient_or_key, content_hash, attempt, latency_ms }
    const newRow = {
      id: '55555555-5555-4555-8555-555555555555',
      agent_run_id: TEST_RUN_ID,
      workspace_id: TEST_WORKSPACE_ID,
      activity_type: 'output_dispatched',
      payload: {
        kind: 'output_dispatched',
        channel: 'sms',
        recipient_or_key: '+19722144223',
        content_hash: 'sha256:abc',
        attempt: 1,
        latency_ms: 312,
      },
      created_at: '2026-05-14T01:00:00.000Z',
    }
    const frames = await fireAndCapture(channel, res, { new: newRow })

    expect(frames.find((f) => f.event === 'ready')).toBeDefined()
    const outputFrame = frames.find((f) => f.event === 'output')
    expect(outputFrame).toBeDefined()
    const payload = JSON.parse(outputFrame!.data!)
    expect(payload).toMatchObject({
      run_id: TEST_RUN_ID,
      kind: 'output_dispatched',
      channel: 'sms',
      to: '+19722144223',
      status: 'dispatched',
      dispatched_at: '2026-05-14T01:00:00.000Z',
    })
  })

  it('forwards output_failed (production payload shape) — flattens error.message; no recipient field', async () => {
    const { app, channel } = await freshApp()
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/outputs/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    // Mirror the REAL OutputFailedEventSchema: { kind, channel,
    // error:{code,message}, retriable } — NO recipient_or_key.
    const newRow = {
      id: '66666666-6666-4666-8666-666666666666',
      agent_run_id: TEST_RUN_ID,
      workspace_id: TEST_WORKSPACE_ID,
      activity_type: 'output_failed',
      payload: {
        kind: 'output_failed',
        channel: 'email',
        error: { code: 'SES_THROTTLED', message: 'SES throttled the request' },
        retriable: true,
      },
      created_at: '2026-05-14T01:01:00.000Z',
    }
    const frames = await fireAndCapture(channel, res, { new: newRow })
    const outputFrame = frames.find((f) => f.event === 'output')
    expect(outputFrame).toBeDefined()
    const payload = JSON.parse(outputFrame!.data!)
    expect(payload).toMatchObject({
      kind: 'output_failed',
      channel: 'email',
      status: 'failed',
      error: 'SES throttled the request',
    })
    // No recipient on failed events — the production payload schema
    // doesn't carry one.
    expect(payload.to).toBeUndefined()
  })

  it('IGNORES non-output activity_types (e.g. tool_call_start)', async () => {
    const { app, channel } = await freshApp()
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/outputs/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    const newRow = {
      id: '77777777-7777-4777-8777-777777777777',
      agent_run_id: TEST_RUN_ID,
      workspace_id: TEST_WORKSPACE_ID,
      activity_type: 'tool_call_start',
      payload: { tool_name: 'send_email' },
      created_at: '2026-05-14T01:02:00.000Z',
    }
    const frames = await fireAndExpectNoOutput(channel, res, { new: newRow })
    expect(frames.some((f) => f.event === 'output')).toBe(false)
    // ready frame still emitted
    expect(frames.find((f) => f.event === 'ready')).toBeDefined()
  })

  it('tolerates legacy payload.to / payload.recipient keys as recipient fallbacks', async () => {
    // Production payload uses `recipient_or_key`, but we accept
    // legacy/alternate keys defensively so a future schema change
    // doesn't silently drop the recipient before the route is updated.
    const { app, channel } = await freshApp()
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/outputs/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    const newRow = {
      id: '88888888-8888-4888-8888-888888888888',
      agent_run_id: TEST_RUN_ID,
      workspace_id: TEST_WORKSPACE_ID,
      activity_type: 'output_dispatched',
      payload: {
        channel: 'sms',
        recipient: '+19722144223', // legacy key, not the production one
      },
      created_at: '2026-05-14T01:03:00.000Z',
    }
    const frames = await fireAndCapture(channel, res, { new: newRow })
    const outputFrame = frames.find((f) => f.event === 'output')
    expect(outputFrame).toBeDefined()
    const payload = JSON.parse(outputFrame!.data!)
    expect(payload.to).toBe('+19722144223')
  })
})

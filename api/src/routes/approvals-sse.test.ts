import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'
const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'

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
  listeners: Record<string, (payload: { new?: unknown; old?: unknown }) => Promise<void>>
  removed: boolean
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    id: '33333333-3333-4333-8333-333333333333',
    run_id: '11111111-1111-4111-8111-111111111111',
    workspace_id: TEST_WORKSPACE_ID,
    tool_name: 'send_email',
    tool_call_id: 'tc_1',
    args_preview: { to: ['a@x.com'], subject: 'hi' },
    args_hash: 'abc123',
    reason: 'send_email to 1 recipient',
    status: 'pending',
    decided_by: null,
    decided_at: null,
    expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    created_at: now.toISOString(),
    ...overrides,
  }
}

function makeMockSupabase(channel: ChannelMock): unknown {
  return {
    channel: () => {
      const builder: Record<string, unknown> = {}
      builder.on = (
        _kind: string,
        cfg: { event: string },
        cb: (payload: { new?: unknown; old?: unknown }) => Promise<void>,
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
    removeAllChannels: async () => {
      channel.removed = true
    },
  }
}

async function freshApp(opts: {
  hydrateRows: Array<Record<string, unknown>>
  channel?: ChannelMock
}) {
  const channel = opts.channel ?? { listeners: {}, removed: false }
  vi.doMock('../db/index.js', () => ({
    db: {
      execute: vi.fn(async () => opts.hydrateRows),
    },
  }))

  const { Hono } = await import('hono')
  const { requireWorkspaceJwt } = await import('../middleware/jwt.js')
  const { approvalsSseRoute, setSupabaseFactoryForTests } = await import('./approvals-sse.js')
  setSupabaseFactoryForTests(() => makeMockSupabase(channel) as never)
  const app = new Hono()
  app.use('/v1/workspaces', requireWorkspaceJwt)
  app.use('/v1/workspaces/*', requireWorkspaceJwt)
  app.route('/v1/workspaces', approvalsSseRoute)
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

/** Single-reader streaming consumer. Continuously drains the response
 *  body, fires the requested realtime callback once both hydrate has
 *  arrived AND all listeners are registered, and resolves with the
 *  collected SSE frames once the approval frame arrives (or the
 *  per-test deadline elapses). */
async function fireAndCapture(
  channel: ChannelMock,
  res: Response,
  eventKind: 'INSERT' | 'UPDATE' | 'DELETE',
  payload: { new?: unknown; old?: unknown },
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
      channel.listeners.UPDATE &&
      channel.listeners.DELETE &&
      frames.some((f) => f.event === 'hydrate')
    ) {
      fired = true
      await channel.listeners[eventKind]!(payload)
    }
    if (frames.some((f) => f.event === 'approval')) break

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

async function readUntilHydrate(
  res: Response,
  deadlineMs = 1_000,
): Promise<Array<{ event?: string; data?: string }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Array<{ event?: string; data?: string }> = []
  let buf = ''
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline && !frames.some((f) => f.event === 'hydrate')) {
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

describe('GET /v1/workspaces/:wsId/approvals/stream', () => {
  it('rejects request with no auth → 401', async () => {
    const { app } = await freshApp({ hydrateRows: [] })
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/approvals/stream`, {
      method: 'GET',
    })
    expect(res.status).toBe(401)
  })

  it('rejects path workspace mismatch → 403', async () => {
    const { app } = await freshApp({ hydrateRows: [] })
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${OTHER_WORKSPACE_ID}/approvals/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ error: 'workspace_mismatch' })
  })

  it('first frame is hydrate with current pending approvals (access_token_hash stripped)', async () => {
    const row = pendingRow()
    const { app } = await freshApp({ hydrateRows: [row] })
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/approvals/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const frames = await readUntilHydrate(res)
    const hydrate = frames.find((f) => f.event === 'hydrate')
    expect(hydrate).toBeDefined()
    const payload = JSON.parse(hydrate!.data!)
    expect(payload.approvals).toHaveLength(1)
    expect(payload.approvals[0].id).toBe(row.id)
    expect(payload.approvals[0].status).toBe('pending')
    expect(payload.approvals[0]).not.toHaveProperty('access_token_hash')
  })

  async function openStream(
    channel: ChannelMock,
  ): Promise<{ res: Response }> {
    const token = await signTestToken(TEST_WORKSPACE_ID)
    const { app } = await freshApp({ hydrateRows: [], channel })
    const res = await app.request(`/v1/workspaces/${TEST_WORKSPACE_ID}/approvals/stream`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    return { res }
  }

  it('forwards a Realtime INSERT as an event: approval frame with op:INSERT', async () => {
    const channel: ChannelMock = { listeners: {}, removed: false }
    const { res } = await openStream(channel)
    const newRow = pendingRow({
      id: '44444444-4444-4444-8444-444444444444',
      access_token_hash: 'secret_hash',
    })
    const frames = await fireAndCapture(channel, res, 'INSERT', { new: newRow })
    const approvalFrame = frames.find((f) => f.event === 'approval')
    expect(approvalFrame).toBeDefined()
    const payload = JSON.parse(approvalFrame!.data!)
    expect(payload.op).toBe('INSERT')
    expect(payload.approval.id).toBe(newRow.id)
    expect(payload.approval).not.toHaveProperty('access_token_hash')
  })

  it('forwards a Realtime UPDATE (status=approved) as an event: approval frame with op:UPDATE', async () => {
    const channel: ChannelMock = { listeners: {}, removed: false }
    const { res } = await openStream(channel)
    const decidedRow = pendingRow({ status: 'approved', decided_by: TEST_ACCOUNT_ID })
    const frames = await fireAndCapture(channel, res, 'UPDATE', { new: decidedRow })
    const approvalFrame = frames.find((f) => f.event === 'approval')
    expect(approvalFrame).toBeDefined()
    const payload = JSON.parse(approvalFrame!.data!)
    expect(payload.op).toBe('UPDATE')
    expect(payload.approval.status).toBe('approved')
  })

  it('forwards a Realtime DELETE as an event: approval frame with op:DELETE', async () => {
    const channel: ChannelMock = { listeners: {}, removed: false }
    const { res } = await openStream(channel)
    const removedRow = pendingRow()
    const frames = await fireAndCapture(channel, res, 'DELETE', { old: removedRow })
    const approvalFrame = frames.find((f) => f.event === 'approval')
    expect(approvalFrame).toBeDefined()
    const payload = JSON.parse(approvalFrame!.data!)
    expect(payload.op).toBe('DELETE')
    expect(payload.approval.id).toBe(removedRow.id)
  })
})

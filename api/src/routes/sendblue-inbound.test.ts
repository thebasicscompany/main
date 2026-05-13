import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000aa'
const TEST_RUN_ID = '11111111-1111-4111-8111-111111111111'
const TEST_APPROVAL_ID = '33333333-3333-4333-8333-333333333333'
const OPERATOR_PHONE = '+19998887777'
const OUR_NUMBER = '+13472760577'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
  process.env.GEMINI_API_KEY = 'test-gemini'
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test'
  process.env.SENDBLUE_API_KEY = 'test-sb-key'
  process.env.SENDBLUE_API_SECRET = 'test-sb-secret'
  process.env.SENDBLUE_FROM_NUMBER = OUR_NUMBER
})

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ message_handle: 'mock' }), { status: 200 })),
  )
})

interface ExecCall { query: string }

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
  const { Hono } = await import('hono')
  const { sendblueInboundRoute } = await import('./sendblue-inbound.js')
  const app = new Hono()
  app.route('/webhooks', sendblueInboundRoute)
  return { app, calls }
}

describe('parseReply', () => {
  it('matches approve lexicon', async () => {
    const { _internals } = await import('./sendblue-inbound.js')
    expect(_internals.parseReply('yes').kind).toBe('approved')
    expect(_internals.parseReply('YES!').kind).toBe('approved')
    expect(_internals.parseReply('Approve please').kind).toBe('approved')
    expect(_internals.parseReply('ok').kind).toBe('approved')
    expect(_internals.parseReply('do it').kind).toBe('approved')
  })

  it('matches deny lexicon', async () => {
    const { _internals } = await import('./sendblue-inbound.js')
    expect(_internals.parseReply('no').kind).toBe('denied')
    expect(_internals.parseReply('NO.').kind).toBe('denied')
    expect(_internals.parseReply('deny').kind).toBe('denied')
    expect(_internals.parseReply('cancel').kind).toBe('denied')
    expect(_internals.parseReply('stop').kind).toBe('denied')
    expect(_internals.parseReply('no thanks').kind).toBe('denied')
  })

  it('returns unknown for ambiguous replies', async () => {
    const { _internals } = await import('./sendblue-inbound.js')
    expect(_internals.parseReply('maybe').kind).toBe('unknown')
    expect(_internals.parseReply('').kind).toBe('unknown')
    expect(_internals.parseReply('what does this mean').kind).toBe('unknown')
  })
})

describe('POST /webhooks/sendblue', () => {
  it('400s on invalid JSON', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('ignores outbound echo', async () => {
    const { app, calls } = await freshApp([])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: OUR_NUMBER,
        to_number: OPERATOR_PHONE,
        content: 'Approval needed: send_email',
        is_outbound: true,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ignored).toBe('outbound')
    expect(calls).toHaveLength(0)
  })

  it('400s when to_number != our SENDBLUE_FROM_NUMBER', async () => {
    const { app } = await freshApp([])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: OPERATOR_PHONE,
        to_number: '+15555555555',
        content: 'yes',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('200 silently ignores unknown sender phone', async () => {
    const { app, calls } = await freshApp([[]])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: '+15555555555',
        to_number: OUR_NUMBER,
        content: 'yes',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ignored).toBe('unknown_sender')
    // Only the workspace-lookup call should have happened.
    expect(calls).toHaveLength(1)
  })

  it('replies with help text on ambiguous reply', async () => {
    const { app, calls } = await freshApp([
      [{ workspace_id: TEST_WORKSPACE_ID, approval_phone: OPERATOR_PHONE }],
    ])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: OPERATOR_PHONE,
        to_number: OUR_NUMBER,
        content: 'maybe',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.action).toBe('help_text')
    // Just the workspace lookup; no UPDATE/INSERT/NOTIFY.
    expect(calls).toHaveLength(1)
    // The help text was sent via fetch to Sendblue.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0)
  })

  it('says "no pending approvals" when none exist', async () => {
    const { app, calls } = await freshApp([
      [{ workspace_id: TEST_WORKSPACE_ID, approval_phone: OPERATOR_PHONE }],
      [], // no pending approvals
    ])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: OPERATOR_PHONE,
        to_number: OUR_NUMBER,
        content: 'yes',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.action).toBe('no_pending')
    expect(calls).toHaveLength(2)
  })

  it('approves on YES — UPDATE, INSERT approval_granted, pg_notify, confirm reply', async () => {
    const { app, calls } = await freshApp([
      [{ workspace_id: TEST_WORKSPACE_ID, approval_phone: OPERATOR_PHONE }],
      [{
        id: TEST_APPROVAL_ID,
        run_id: TEST_RUN_ID,
        tool_name: 'send_email',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        account_id: TEST_ACCOUNT_ID,
      }],
      [], // UPDATE
      [], // INSERT cloud_activity
      [], // pg_notify
    ])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: OPERATOR_PHONE,
        to_number: OUR_NUMBER,
        content: 'YES!',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.decision).toBe('approved')
    expect(body.approvalId).toBe(TEST_APPROVAL_ID)
    expect(body.notified).toBe(true)

    expect(calls).toHaveLength(5)
    expect(calls[2]!.query.toLowerCase()).toContain('update')
    expect(calls[3]!.query).toContain('approval_granted')
    expect(calls[3]!.query).toContain('sms_reply')
    expect(calls[4]!.query).toContain('pg_notify')
    expect(calls[4]!.query).toContain(`approval_${TEST_APPROVAL_ID.replace(/-/g, '_')}`)

    // Confirmation reply went out via Sendblue.
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!
    const bodyStr = (lastCall[1].body as string)
    expect(bodyStr).toContain('Approved')
  })

  it('denies on NO — INSERT approval_denied + confirm reply', async () => {
    const { app, calls } = await freshApp([
      [{ workspace_id: TEST_WORKSPACE_ID, approval_phone: OPERATOR_PHONE }],
      [{
        id: TEST_APPROVAL_ID,
        run_id: TEST_RUN_ID,
        tool_name: 'send_email',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        account_id: TEST_ACCOUNT_ID,
      }],
      [], [], [],
    ])
    const res = await app.request('/webhooks/sendblue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_number: OPERATOR_PHONE,
        to_number: OUR_NUMBER,
        content: 'no thanks',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.decision).toBe('denied')
    expect(calls[3]!.query).toContain('approval_denied')
  })
})

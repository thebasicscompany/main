// Staging smoke against deployed Fargate service.
// Run via:  doppler run --project backend --config dev -- node api/staging-smoke.mjs <ALB_URL>
// e.g.       node api/staging-smoke.mjs http://RuntimeApi-12345.us-east-1.elb.amazonaws.com
//
// Tests phases 00-08 against real cloud infra: real Supabase, real
// Browserbase (subject to free-tier quota), real Anthropic.

import { SignJWT } from 'jose'

const BASE = process.argv[2] ?? process.env.RUNTIME_BASE_URL
if (!BASE) { console.error('usage: node staging-smoke.mjs <ALB_URL>'); process.exit(1) }
const SECRET = process.env.WORKSPACE_JWT_SECRET
if (!SECRET) { console.error('WORKSPACE_JWT_SECRET missing — run via doppler'); process.exit(1) }

const WS = '139e7cdc-7060-49c8-a04f-2afffddbd708'
const ACCT = 'aa9dd140-def8-4e8e-9955-4acc04e11fea'

const now = Math.floor(Date.now() / 1000)
const exp = now + 3600
const TOKEN = await new SignJWT({
  workspace_id: WS, account_id: ACCT, plan: 'free', seat_status: 'active',
  issued_at: new Date(now * 1000).toISOString(),
  expires_at: new Date(exp * 1000).toISOString(),
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt(now)
  .setExpirationTime(exp)
  .sign(new TextEncoder().encode(SECRET))

const H = { 'X-Workspace-Token': TOKEN, 'Content-Type': 'application/json' }

let pass = 0, fail = 0
async function test(name, fn) {
  process.stdout.write(`▶ ${name} ... `)
  try { await fn(); console.log('ok'); pass++ }
  catch (e) { console.log('FAIL\n  →', e.message); fail++ }
}
function assert(c, m) { if (!c) throw new Error(m) }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`) }
async function http(method, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: opts.unauth ? { 'Content-Type': 'application/json' } : H,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json }
}

console.log(`Target: ${BASE}\n`)

// ─── infra reachability ────────────────────────────────────────────────────
await test('ALB → /health is reachable and 200', async () => {
  const r = await http('GET', '/health', { unauth: true })
  assertEq(r.status, 200, 'status')
})
await test('JWT auth gate works on /v1/runtime/health', async () => {
  const r1 = await http('GET', '/v1/runtime/health', { unauth: true })
  assertEq(r1.status, 401, 'no token')
  const r2 = await http('GET', '/v1/runtime/health')
  assertEq(r2.status, 200, 'with token')
})
await test('DB-backed list endpoint succeeds', async () => {
  const r = await http('GET', '/v1/runtime/runs?limit=5')
  assertEq(r.status, 200, 'status')
  assert(Array.isArray(r.body.runs), 'shape')
})

// ─── Phase 07 ──────────────────────────────────────────────────────────────
let contextOk = false
await test('Phase 07: GET /v1/runtime/contexts/me', async () => {
  const r = await http('GET', '/v1/runtime/contexts/me')
  assertEq(r.status, 200, 'status')
  contextOk = true
  console.log('\n     contextId =', r.body.context_id, '\n     lastSyncedAt =', r.body.last_synced_at)
})

// ─── Phase 01 + 05 (cheap path: hello-world only) ──────────────────────────
let runId = null
await test('hello-world: POST /v1/runtime/runs', async () => {
  const r = await http('POST', '/v1/runtime/runs', { body: { workflow_id: 'hello-world' } })
  if (r.status !== 200 && r.status !== 201) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`)
  runId = r.body.run_id
  console.log('\n     runId =', runId, '\n     liveUrl =', r.body.live_url)
})

await test('hello-world: reaches terminal status', async () => {
  if (!runId) throw new Error('no runId')
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const r = await http('GET', `/v1/runtime/runs/${runId}`)
    if (r.status !== 200) throw new Error(`get=${r.status}`)
    const s = r.body.status
    if (['completed', 'failed', 'verified', 'unverified'].includes(s)) {
      console.log('\n     final status =', s)
      if (s === 'failed') throw new Error('failed: ' + JSON.stringify(r.body))
      return
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('timeout')
})

await test('hello-world: audit endpoints respond', async () => {
  const steps = await http('GET', `/v1/runtime/runs/${runId}/steps`)
  const tools = await http('GET', `/v1/runtime/runs/${runId}/tool-calls`)
  assertEq(steps.status, 200, 'steps status')
  assertEq(tools.status, 200, 'tools status')
  console.log('\n     steps =', steps.body.steps.length, '  tool_calls =', tools.body.tool_calls.length)
})

await test('?include=steps,tool_calls works', async () => {
  const r = await http('GET', `/v1/runtime/runs/${runId}?include=steps,tool_calls`)
  assertEq(r.status, 200, 'status')
  assert(r.body.steps !== undefined, 'steps included')
  assert(r.body.tool_calls !== undefined, 'tool_calls included')
})

console.log(`\n──────── ${pass} pass / ${fail} fail ────────`)
process.exit(fail > 0 ? 1 : 0)

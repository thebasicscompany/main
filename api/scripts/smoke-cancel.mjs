// PR 1 smoke: trigger a real run, then cancel it, then assert the four
// post-conditions (cloud_runs.status, cloud_session_bindings.ended_at,
// cloud_pools.slots_used, cloud_activity run_cancelled row).
//
// Usage:
//   node --env-file=.env api/scripts/smoke-cancel.mjs
//
// Reads from env: WORKSPACE_JWT_SECRET, API_BASE (optional, default prod).

import { SignJWT } from 'jose'

const BASE = process.env.API_BASE ?? 'https://api.trybasics.ai'
const SECRET = process.env.WORKSPACE_JWT_SECRET
if (!SECRET) {
  console.error('WORKSPACE_JWT_SECRET missing — run via `node --env-file=.env`')
  process.exit(1)
}

const WS = '139e7cdc-7060-49c8-a04f-2afffddbd708'
const ACCT = 'aa9dd140-def8-4e8e-9955-4acc04e11fea'

const now = Math.floor(Date.now() / 1000)
const exp = now + 3600
const token = await new SignJWT({
  workspace_id: WS,
  account_id: ACCT,
  plan: 'free',
  seat_status: 'active',
  issued_at: new Date(now * 1000).toISOString(),
  expires_at: new Date(exp * 1000).toISOString(),
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt(now)
  .setExpirationTime(exp)
  .sign(new TextEncoder().encode(SECRET))

const H = { 'X-Workspace-Token': token, 'Content-Type': 'application/json' }

console.log(`# Target: ${BASE}`)
console.log(`# Workspace: ${WS}`)

// 1. Trigger a run.
console.log('\n[1] POST /v1/runs ...')
const startRes = await fetch(`${BASE}/v1/runs`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    goal: 'Open https://news.ycombinator.com. For each of the top 30 stories, click into it, read the article, then summarize. Take 5+ minutes — do not rush. Be very thorough.',
  }),
})
const startBody = await startRes.json()
console.log(`    status=${startRes.status} body=${JSON.stringify(startBody)}`)
if (startRes.status !== 201) {
  console.error('    FAIL: expected 201')
  process.exit(1)
}
const runId = startBody.runId

// 2. Poll until the run has a binding (i.e. a pool picked it up). With a
//    warm pool already registered, this should take 1-5 s. With no pool,
//    expect 30-90 s for ECS schedule + opencode-serve boot.
console.log(`\n[2] waiting for pool to bind run ${runId} ...`)
const startedAt = Date.now()
const TIMEOUT_MS = 90_000
let bound = false
let lastListBody = null
while (Date.now() - startedAt < TIMEOUT_MS) {
  const r = await fetch(`${BASE}/v1/runs?limit=20`, { headers: H })
  if (r.ok) {
    lastListBody = await r.json()
    const me = (lastListBody.runs ?? []).find((row) => row.id === runId)
    if (me) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`    [${elapsed}s] status=${me.status} bb_session=${me.browserbase_session_id ?? '-'}`)
      if (me.browserbase_session_id || me.status === 'running') {
        bound = true
        break
      }
      if (me.status === 'completed' || me.status === 'error' || me.status === 'failed' || me.status === 'cancelled') {
        console.log(`    run ended before we could bind: status=${me.status}`)
        break
      }
    }
  }
  await new Promise((r) => setTimeout(r, 5_000))
}
if (!bound) {
  console.log(`    no binding after ${TIMEOUT_MS / 1000}s — proceeding to cancel anyway (tests pre-dispatch path)`)
}

// 3. Cancel.
console.log(`\n[3] POST /v1/runs/${runId}/cancel ...`)
const cancelRes = await fetch(`${BASE}/v1/runs/${runId}/cancel`, {
  method: 'POST',
  headers: H,
})
const cancelBody = await cancelRes.json()
console.log(`    status=${cancelRes.status} body=${JSON.stringify(cancelBody)}`)
if (cancelRes.status !== 200 && cancelRes.status !== 202) {
  console.error('    FAIL: expected 200 or 202')
  process.exit(1)
}

// 4. Idempotent re-cancel.
console.log(`\n[4] POST /v1/runs/${runId}/cancel (second time, idempotency check) ...`)
const recancel = await fetch(`${BASE}/v1/runs/${runId}/cancel`, {
  method: 'POST',
  headers: H,
})
const recancelBody = await recancel.json()
console.log(`    status=${recancel.status} body=${JSON.stringify(recancelBody)}`)

// 5. Print run id for the operator-side DB verify (Supabase MCP).
console.log(`\n# Now verify against the DB (run via supabase MCP):`)
console.log(`#   SELECT status, completed_at FROM public.cloud_runs WHERE id = '${runId}';`)
console.log(`#   SELECT session_id, ended_at FROM public.cloud_session_bindings WHERE run_id = '${runId}';`)
console.log(`#   SELECT activity_type FROM public.cloud_activity WHERE agent_run_id = '${runId}' AND activity_type IN ('run_started','run_completed','run_cancelled') ORDER BY created_at;`)
console.log(`#   SELECT pool_id, status, slots_used FROM public.cloud_pools ORDER BY started_at DESC LIMIT 5;`)
console.log(`\nrunId=${runId}`)

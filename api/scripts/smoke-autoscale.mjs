// PR 2 smoke: drive enough concurrent traffic to push the autoscaler
// past MIN_FREE_SLOTS, verify it launches a 2nd pool, then watch the
// runs complete + reaper bring the fleet back down.
//
// Usage: doppler run --project backend --config dev -- \
//        node api/scripts/smoke-autoscale.mjs

import { SignJWT } from 'jose'

const BASE = process.env.API_BASE ?? 'https://api.trybasics.ai'
const SECRET = process.env.WORKSPACE_JWT_SECRET
if (!SECRET) {
  console.error('WORKSPACE_JWT_SECRET missing')
  process.exit(1)
}

const WS = '139e7cdc-7060-49c8-a04f-2afffddbd708'
const ACCT = 'aa9dd140-def8-4e8e-9955-4acc04e11fea'

async function mintToken() {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 3600
  return await new SignJWT({
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
}

const token = await mintToken()
const H = { 'X-Workspace-Token': token, 'Content-Type': 'application/json' }

// Goal needs to take long enough that several runs hold slots simultaneously.
// "Open and read 5 articles" usually takes 60-120s.
const GOAL =
  'Open https://news.ycombinator.com. Click into the first 5 stories and read each article. ' +
  'For each, write a one-paragraph summary including the source URL. Take your time.'

const N_RUNS = 6
console.log(`# Firing ${N_RUNS} concurrent runs against ${BASE}`)
console.log(`# Goal length: ${GOAL.length} chars\n`)

console.log('[T+0] POST /v1/runs x N')
const startedAt = Date.now()
const runs = await Promise.all(
  Array.from({ length: N_RUNS }, async (_, i) => {
    const r = await fetch(`${BASE}/v1/runs`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ goal: GOAL }),
    })
    const j = await r.json()
    return { idx: i, status: r.status, runId: j.runId, body: j }
  }),
)
for (const r of runs) {
  console.log(`    [run ${r.idx}] status=${r.status} runId=${r.runId}`)
}

const ids = runs.filter((r) => r.status === 201).map((r) => r.runId)
if (ids.length === 0) {
  console.error('    no runs accepted; bailing')
  process.exit(1)
}

// Poll the run list every 5s for 4 minutes; print a line per tick
// summarizing how many runs are pending/running/completed/cancelled,
// plus per-pool slot usage.
console.log('\n[T+0] watching runs + pool state for 4 minutes ...\n')

function elapsed() {
  return `T+${Math.round((Date.now() - startedAt) / 1000)}s`
}

const TIMEOUT_MS = 4 * 60_000
let lastSnapshot = ''
while (Date.now() - startedAt < TIMEOUT_MS) {
  const r = await fetch(`${BASE}/v1/runs?limit=50`, { headers: H })
  if (!r.ok) {
    console.log(`    [${elapsed()}] /v1/runs returned ${r.status}`)
    await new Promise((res) => setTimeout(res, 5_000))
    continue
  }
  const j = await r.json()
  const mine = (j.runs ?? []).filter((row) => ids.includes(row.id))
  const counts = mine.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1
    return acc
  }, {})
  const summary = JSON.stringify(counts)
  if (summary !== lastSnapshot) {
    console.log(`    [${elapsed()}] runs=${summary}`)
    lastSnapshot = summary
  }
  // Terminal when every run is in a non-pending non-running state.
  const stillActive = mine.some(
    (row) => row.status === 'pending' || row.status === 'running',
  )
  if (!stillActive && mine.length === ids.length) {
    console.log(`    [${elapsed()}] all runs terminal; exiting watch loop`)
    break
  }
  await new Promise((res) => setTimeout(res, 5_000))
}

console.log('\n# Run IDs (verify pool/binding state via Supabase MCP):')
for (const id of ids) console.log(`#   ${id}`)

console.log('\n# Suggested verifies:')
console.log(`#   SELECT pool_id, status, slots_used, slots_max,`)
console.log(`#          last_activity_at::text, started_at::text`)
console.log(`#     FROM public.cloud_pools`)
console.log(`#    WHERE started_at > now() - interval '15 minutes'`)
console.log(`#    ORDER BY started_at DESC;`)
console.log(`#`)
console.log(`#   SELECT id, status, started_at::text, completed_at::text`)
console.log(`#     FROM public.cloud_runs`)
console.log(`#    WHERE id IN (${ids.map((i) => `'${i}'`).join(',')});`)

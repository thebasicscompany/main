// Smoke-test the runtime API end-to-end.
//   1. POST /v1/runtime/runs to start a hello-world run
//   2. Open the SSE event stream and print events until run_completed/failed
//   3. Print run_id / browserbase session id / live url at the start.
// Usage: WORKSPACE_TOKEN=$(cat /tmp/wsjwt.txt) node smoke-run.mjs [workflow_id]

const BASE = process.env.API_BASE ?? 'https://api.trybasics.ai'
const WORKFLOW = process.argv[2] ?? 'hello-world'
const TOKEN = process.env.WORKSPACE_TOKEN
if (!TOKEN) throw new Error('WORKSPACE_TOKEN env var required')

const startRes = await fetch(`${BASE}/v1/runtime/runs`, {
  method: 'POST',
  headers: {
    'X-Workspace-Token': TOKEN,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ workflow_id: WORKFLOW }),
})
const startBody = await startRes.json()
console.log(`POST /v1/runtime/runs → ${startRes.status}`)
console.log(JSON.stringify(startBody, null, 2))
if (!startRes.ok) process.exit(1)

const runId = startBody.run_id
console.log(`\n--- streaming SSE for run ${runId} ---`)

const sseRes = await fetch(`${BASE}/v1/runtime/runs/${runId}/events`, {
  headers: {
    'X-Workspace-Token': TOKEN,
    accept: 'text/event-stream',
  },
})
if (!sseRes.ok) {
  console.error('SSE failed', sseRes.status, await sseRes.text())
  process.exit(1)
}

const reader = sseRes.body.getReader()
const decoder = new TextDecoder()
let buf = ''
let terminal = false

while (!terminal) {
  const { value, done } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  let idx
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const block = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    let parsed = data
    try {
      parsed = JSON.parse(data)
    } catch {}
    if (event === 'screenshot_captured' && parsed?.data_url) {
      const len = parsed.data_url.length
      console.log(`[${event}] screenshot data_url (${len} chars)`)
    } else {
      const summary =
        typeof parsed === 'object'
          ? JSON.stringify(parsed).slice(0, 280)
          : String(parsed).slice(0, 280)
      console.log(`[${event}] ${summary}`)
    }
    if (event === 'run_completed' || event === 'run_failed') {
      terminal = true
      break
    }
  }
}

console.log('\n--- stream closed ---')

// Dev-only: log into a site (e.g. youtube.com) inside a Browserbase live
// session so the cookies persist into a per-workspace Browserbase Context.
// Once this script finishes, runtime workflows for the same workspace boot
// already-logged-in.
//
// Flow:
//   1. Get-or-create the workspace's Browserbase Context.
//   2. Persist the Context id onto public.workspaces.browserbase_profile_id.
//   3. Boot a Browserbase session pointed at the Context with persist=true.
//   4. Print the liveUrl. You open it, log into your sites, come back and
//      press Enter.
//   5. Script stops the session cleanly so Browserbase persists state.
//
// Required env (Doppler-injectable):
//   BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, SUPABASE_DATABASE_URL
//   WORKSPACE_ID (defaults to the dev workspace 139e7cdc-…)
//
// Note: uses SUPABASE_DATABASE_URL (the hosted prod connection string),
// NOT DATABASE_URL — the latter points at a local Supabase dev stack
// that isn't running on this machine.

import postgres from 'postgres'
import readline from 'node:readline'
import { attach, detach, goto_url, wait_for_load } from '@basics/harness'

const BB_KEY = process.env.BROWSERBASE_API_KEY
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID
const SUPABASE_DATABASE_URL = process.env.SUPABASE_DATABASE_URL
const WORKSPACE_ID =
  process.env.WORKSPACE_ID ?? '139e7cdc-7060-49c8-a04f-2afffddbd708'
// Pre-navigate the session to this URL so you land on the login page
// instead of staring at about:blank inside the DevTools-fullscreen view.
const START_URL = process.env.START_URL ?? 'https://www.youtube.com'
const SESSION_TIMEOUT_MS = 1_800_000 // 30 min — plenty of time to log into a few sites

if (!BB_KEY) throw new Error('BROWSERBASE_API_KEY not set')
if (!BB_PROJECT) throw new Error('BROWSERBASE_PROJECT_ID not set')
if (!SUPABASE_DATABASE_URL) throw new Error('SUPABASE_DATABASE_URL not set')

const sql = postgres(SUPABASE_DATABASE_URL, { max: 1, prepare: false })

async function bb(path, init = {}) {
  const res = await fetch(`https://api.browserbase.com/v1${path}`, {
    ...init,
    headers: {
      'X-BB-API-Key': BB_KEY,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Browserbase ${init.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }
  return text ? JSON.parse(text) : {}
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
}

try {
  // 1. Look up or create the Context for this workspace.
  const wsRows = await sql`
    SELECT id, name, browserbase_profile_id
    FROM public.workspaces
    WHERE id = ${WORKSPACE_ID}
  `
  if (wsRows.length === 0) {
    throw new Error(`workspace ${WORKSPACE_ID} not found`)
  }
  const ws = wsRows[0]
  console.log(`workspace: ${ws.name} (${ws.id})`)

  let contextId = ws.browserbase_profile_id
  if (!contextId) {
    console.log('no context pinned to workspace yet — creating one…')
    const ctx = await bb('/contexts', {
      method: 'POST',
      body: JSON.stringify({ projectId: BB_PROJECT }),
    })
    contextId = ctx.id
    await sql`
      UPDATE public.workspaces
      SET browserbase_profile_id = ${contextId}
      WHERE id = ${WORKSPACE_ID}
    `
    console.log(`created Context ${contextId} and pinned it to workspace`)
  } else {
    console.log(`reusing existing Context ${contextId}`)
  }

  // 2. Boot a session attached to the Context, persist=true.
  //    `keepAlive: true` keeps Browserbase from auto-stopping the session
  //    the moment the pre-navigate CDP connection closes — the user needs
  //    the session to stay up between our detach and their interactive login.
  const session = await bb('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: BB_PROJECT,
      keepAlive: true,
      browserSettings: {
        timeout: SESSION_TIMEOUT_MS,
        context: { id: contextId, persist: true },
      },
      userMetadata: { workspace_id: WORKSPACE_ID, purpose: 'dev_cookie_login' },
    }),
  })
  console.log(`session ${session.id} created`)

  // 3. Pre-navigate to START_URL so you land on the actual login page
  //    rather than about:blank. Best-effort — if the navigate fails the
  //    user can still drive the live view manually.
  try {
    const cdpSession = await attach({ wsUrl: session.connectUrl })
    try {
      await goto_url(cdpSession, START_URL)
      await wait_for_load(cdpSession, 15)
      console.log(`pre-navigated to ${START_URL}`)
    } finally {
      await detach(cdpSession).catch(() => {})
    }
  } catch (err) {
    console.warn(`pre-navigate failed (${err.message}) — continuing; you can navigate manually in the live view`)
  }

  // 4. Get the live (interactive) URL.
  const debug = await bb(`/sessions/${encodeURIComponent(session.id)}/debug`)
  const liveUrl = debug.debuggerFullscreenUrl ?? debug.debuggerUrl

  console.log('')
  console.log('================================================================')
  console.log('OPEN THIS URL IN YOUR BROWSER AND LOG INTO YOUR SITES:')
  console.log(liveUrl)
  console.log('================================================================')
  console.log(`(session expires in ${SESSION_TIMEOUT_MS / 60_000} min)`)
  console.log('')

  await prompt('Press Enter once you are done logging in… ')

  // 5. Clean stop → cookies persist into the Context.
  await bb(`/sessions/${encodeURIComponent(session.id)}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
  })
  await sql`
    UPDATE public.workspaces
    SET last_cookie_sync_at = NOW()
    WHERE id = ${WORKSPACE_ID}
  `
  console.log(`session stopped — cookies persisted to Context ${contextId}`)
  console.log('next run for this workspace will boot already-logged-in.')
} finally {
  await sql.end({ timeout: 5 })
}

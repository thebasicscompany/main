import { getConfig } from '../config.js'
import { BrowserbaseUnavailableError, InternalError } from './errors.js'

/**
 * Browserbase HTTP client for the runtime.
 *
 * Lifted from `agent/api/src/lib/browserbase.ts` with two adaptations:
 *  - throws `BrowserbaseUnavailableError` (capability-gated 503) when env
 *    keys are missing, rather than the agent's generic env-required error,
 *    so the runtime route can map the missing-key case to the contracted
 *    `{ error: 'browserbase_unavailable' }` 503 response.
 *  - exposes `liveUrl` alongside `cdpWsUrl` because the dashboard iframe
 *    target in Phase 01 needs the debugger fullscreen URL.
 *
 * www.browserbase.com is the dashboard host and 307-redirects /v1/* to a
 * sign-in page; the actual API lives at api.browserbase.com and
 * authenticates via X-BB-API-Key (not Bearer).
 */
const BROWSERBASE_BASE = 'https://api.browserbase.com/v1'

export interface CreateSessionOptions {
  workspaceId: string
  runId: string
  timeoutMs?: number
  /** Pin the session to a workspace's persistent Browserbase Context so
   *  cookies + localStorage from prior runs are loaded. */
  contextId?: string
  /** When `contextId` is set, controls whether mutations during this run
   *  persist back into the Context on a clean stop. Default true. */
  persistContext?: boolean
}

export interface BrowserbaseSession {
  sessionId: string
  liveUrl: string
  cdpWsUrl: string
}

function requireKeys(): { apiKey: string; projectId: string } {
  const env = getConfig()
  const apiKey = env.BROWSERBASE_API_KEY
  const projectId = env.BROWSERBASE_PROJECT_ID
  if (!apiKey || apiKey.trim().length === 0) {
    throw new BrowserbaseUnavailableError('BROWSERBASE_API_KEY is not configured')
  }
  if (!projectId || projectId.trim().length === 0) {
    throw new BrowserbaseUnavailableError('BROWSERBASE_PROJECT_ID is not configured')
  }
  return { apiKey, projectId }
}

async function browserbaseFetch(
  apiKey: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BROWSERBASE_BASE}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          'X-BB-API-Key': apiKey,
          'content-type': 'application/json',
        },
      })
      if (res.ok) return res
      // Retry once on 5xx; surface 4xx immediately so caller can react.
      if (res.status >= 500 && attempt === 0) {
        lastError = new InternalError(
          `Browserbase ${path} failed: ${res.status}`,
        )
        continue
      }
      const body = await res.text().catch(() => '')
      throw new InternalError(
        `Browserbase ${path} failed: ${res.status} ${body.slice(0, 300)}`,
      )
    } catch (err) {
      lastError = err
      if (attempt === 1) break
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new InternalError('Browserbase request failed')
}

/**
 * Create a new Browserbase session and resolve the live-view URL.
 *
 * Two API calls in sequence: `POST /v1/sessions` for the
 * `{ id, connectUrl }` then `GET /v1/sessions/:id/debug` for the
 * `debuggerFullscreenUrl` (the iframe target). Browserbase's session-create
 * response does not include the debug URL — it's a separate endpoint.
 *
 * Throws `BrowserbaseUnavailableError` if env keys are missing.
 */
export async function createSession(
  opts: CreateSessionOptions,
): Promise<BrowserbaseSession> {
  const { apiKey, projectId } = requireKeys()
  const browserSettings: Record<string, unknown> = {
    // Default 30 min: agent loops (model_call → tool_dispatch × N) routinely
    // exceed 5 min on real workflows. Sessions still close as soon as the
    // orchestrator's finally-block calls stopSession, so cost tracks actual
    // runtime, not the cap.
    //
    // Browserbase's `browserSettings.timeout` is in SECONDS — sending raw
    // milliseconds (1_800_000) overflows the plan max and BB silently
    // clamps to ~5 min, which kills operator-driven flows like E.5's
    // LinkedIn live-view login. Convert ms → s here so callers keep the
    // ms interface used elsewhere in this codebase.
    timeout: Math.ceil((opts.timeoutMs ?? 1_800_000) / 1000),
  }
  if (opts.contextId) {
    browserSettings.context = {
      id: opts.contextId,
      persist: opts.persistContext ?? true,
    }
  }

  const createRes = await browserbaseFetch(apiKey, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      browserSettings,
      userMetadata: {
        workspace_id: opts.workspaceId,
        run_id: opts.runId,
      },
    }),
  })
  const created = (await createRes.json()) as {
    id: string
    connectUrl: string
  }

  const debugRes = await browserbaseFetch(
    apiKey,
    `/sessions/${encodeURIComponent(created.id)}/debug`,
    { method: 'GET' },
  )
  const debugInfo = (await debugRes.json()) as {
    debuggerFullscreenUrl?: string
    debuggerUrl?: string
  }

  // E.5 — prefer `debuggerUrl` (the iframe-friendly inspector page) over
  // `debuggerFullscreenUrl`. The fullscreen variant's wss handshake fails
  // for sessions outside us-east-1 because the URL is missing the region
  // prefix + signingKey; the `debuggerUrl` page handles regional routing
  // correctly and is what BB embeds in their own dashboard live-view.
  const liveUrl = debugInfo.debuggerUrl ?? debugInfo.debuggerFullscreenUrl ?? ''

  return {
    sessionId: created.id,
    liveUrl,
    cdpWsUrl: created.connectUrl,
  }
}

/**
 * Stop a Browserbase session. Always call from `finally`.
 *
 * Browserbase no longer accepts the `/stop` suffix; the documented stop
 * shape is `POST /sessions/<id>` with body `{ status: "REQUEST_RELEASE" }`.
 * The endpoint returns the session object with status flipped to COMPLETED.
 *
 * For sessions launched against a Context, a clean stop is what persists
 * the Context state (cookies + localStorage) for future sessions. Phase 07
 * leans on this — see `lib/contextSync.ts`.
 */
export async function stopSession(sessionId: string): Promise<void> {
  if (!sessionId) return
  const { apiKey } = requireKeys()
  await browserbaseFetch(apiKey, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
  })
}

// ── Persistent Contexts (Phase 07 — Lens cookie/state sync) ─────────────
//
// Browserbase Contexts hold per-workspace browser state (cookies +
// localStorage + IndexedDB). A session launched with `browserSettings.context
// = { id, persist: true }` boots Chromium pre-loaded with that state and,
// on a clean `stopSession` call, persists any mutations back into the
// Context. Phase 07 uses Contexts as the canonical store for Lens-synced
// cookies, replacing agent/'s Profile-based path.

export interface BrowserbaseContext {
  contextId: string
}

export interface CreateSessionWithContextOptions {
  workspaceId: string
  contextId: string
  /** When true (default), changes made during the session persist back to
   *  the Context on a clean stop. Cookie sync always wants this. */
  persist?: boolean
  /** Browserbase session timeout in ms; we keep cookie-sync sessions
   *  short-lived (default 60s) since the only work is a few CDP commands. */
  timeoutMs?: number
}

/**
 * Create a new long-lived Context under the configured project. The
 * resulting `contextId` is what we pin on `public.workspaces.
 * browserbase_profile_id` for the workspace.
 */
export async function createContext(): Promise<BrowserbaseContext> {
  const { apiKey, projectId } = requireKeys()
  const res = await browserbaseFetch(apiKey, '/contexts', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
  const json = (await res.json()) as { id: string }
  return { contextId: json.id }
}

/**
 * Create a session pointed at a Context. `persist` defaults to true so
 * cookie-sync sessions write their CDP-injected state back to the Context
 * on clean stop.
 *
 * The returned `cdpWsUrl` is the WebSocket the runtime opens via
 * chrome-remote-interface (`local: true` — see HANDOFF gotcha #1).
 */
export async function createSessionWithContext(
  opts: CreateSessionWithContextOptions,
): Promise<BrowserbaseSession> {
  const { apiKey, projectId } = requireKeys()
  const persist = opts.persist ?? true
  const createRes = await browserbaseFetch(apiKey, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      browserSettings: {
        timeout: opts.timeoutMs ?? 60_000,
        context: { id: opts.contextId, persist },
      },
      userMetadata: {
        workspace_id: opts.workspaceId,
        purpose: 'cookie_sync',
      },
    }),
  })
  const created = (await createRes.json()) as {
    id: string
    connectUrl: string
  }
  // Cookie-sync flow doesn't need the live-view URL (no human is watching),
  // but we keep the same return shape as `createSession` so the harness
  // attach helper is interchangeable.
  return {
    sessionId: created.id,
    liveUrl: '',
    cdpWsUrl: created.connectUrl,
  }
}

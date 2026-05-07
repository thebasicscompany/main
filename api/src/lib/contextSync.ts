/**
 * Cookie / localStorage injection into a Browserbase Context — Phase 07.
 *
 * The runtime side of the Lens cookie-sync flow:
 *   1. Boot a short-lived Browserbase session pointed at the workspace's
 *      Context (with `persist: true`).
 *   2. Open a CDP connection via chrome-remote-interface (`local: true` —
 *      see HANDOFF gotcha #1).
 *   3. Inject cookies via `Storage.setCookies` and (optionally) localStorage
 *      entries via `Storage.setStorageItems`.
 *   4. Stop the session cleanly — that's what causes Browserbase to persist
 *      the Context state (cookies + storage) for future runs.
 *
 * The CDP factory (`AttachFn`) and Browserbase client are injected so tests
 * can mock both without touching real Browserbase or spawning a Chrome.
 *
 * Public entry point: `syncCookiesToContext(...)`.
 *
 * NOTE: cookie *values* are sensitive. This module never logs them — only
 * counts and (deduped) domain summaries.
 */

import type { CdpSession } from '@basics/harness'
import {
  createSessionWithContext,
  stopSession,
  type BrowserbaseSession,
} from './browserbase.js'

/**
 * CDP-shaped cookie. Mirrors `Network.CookieParam` from the DevTools
 * Protocol and matches what desktop's TS extractor sends to agent/'s
 * `/v1/cookie-sync/upload` (see desktop/src/main/gateway/client.ts:837).
 */
export interface CookieInput {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  size: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/**
 * One localStorage entry. `securityOrigin` matches the CDP
 * `Storage.StorageId.securityOrigin` shape (e.g. `https://salesforce.com`).
 *
 * Phase 07 v1 accepts these as an optional input — desktop's existing TS
 * extractor only ships cookies today, but the CDP injection path is here
 * so a future Lens pass that ships localStorage doesn't need a route
 * change. If `localStorage` is empty/undefined, the storage step is skipped.
 */
export interface LocalStorageInput {
  securityOrigin: string
  key: string
  value: string
}

export interface SyncCookiesToContextInput {
  workspaceId: string
  contextId: string
  cookies: CookieInput[]
  localStorage?: LocalStorageInput[]
  /**
   * Optional include-domains filter. When set, only cookies whose
   * (leading-dot-stripped) domain ends with one of these is injected.
   * Matches the conceptual "include-domains list" from
   * ARCHITECTURE.md cookie-sync flow line 224.
   */
  domains?: string[]
}

export interface SyncCookiesToContextResult {
  injectedCookies: number
  injectedItems: number
  domains: string[]
}

/**
 * Function shape for the CDP-attach callback. Tests pass a stub that
 * returns a fake `CdpSession`; production wires
 * `import('@basics/harness').attach`. Kept narrower than `attach` so we
 * don't drag the harness's optional buffer-size knob into this surface.
 */
export type AttachFn = (opts: { wsUrl: string }) => Promise<CdpSession>

/**
 * Function shape for booting a session against a Context. Production passes
 * `createSessionWithContext` from `lib/browserbase.ts`; tests inject a stub.
 */
export type CreateSessionFn = (opts: {
  workspaceId: string
  contextId: string
  persist?: boolean
}) => Promise<BrowserbaseSession>

/**
 * Function shape for cleanly stopping a session. Production passes
 * `stopSession`; tests inject a stub.
 */
export type StopSessionFn = (sessionId: string) => Promise<void>

export interface SyncCookiesToContextDeps {
  attach: AttachFn
  createSession: CreateSessionFn
  stopSession: StopSessionFn
}

function normalizeDomain(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain
}

function filterByDomains(
  cookies: CookieInput[],
  includeDomains: string[] | undefined,
): CookieInput[] {
  if (!includeDomains || includeDomains.length === 0) return cookies
  const normIncludes = includeDomains.map(normalizeDomain).map((d) =>
    d.toLowerCase(),
  )
  return cookies.filter((c) => {
    const d = normalizeDomain(c.domain).toLowerCase()
    return normIncludes.some((inc) => d === inc || d.endsWith(`.${inc}`))
  })
}

function uniqueDomains(cookies: CookieInput[]): string[] {
  const set = new Set<string>()
  for (const c of cookies) {
    const d = normalizeDomain(c.domain)
    if (d) set.add(d)
  }
  return [...set].sort()
}

/**
 * Group localStorage entries by `securityOrigin` so each
 * `Storage.setStorageItems` call sees one origin's keys in one round trip.
 */
function groupByOrigin(
  items: LocalStorageInput[],
): Map<string, LocalStorageInput[]> {
  const out = new Map<string, LocalStorageInput[]>()
  for (const it of items) {
    const list = out.get(it.securityOrigin)
    if (list) list.push(it)
    else out.set(it.securityOrigin, [it])
  }
  return out
}

/**
 * Send one CDP command over the harness session. The harness's `client.send`
 * is positional `(method, params, sessionId?)`; for cookie-sync work we use
 * the browser-level Network domain (no sessionId — applies globally to the
 * browser context, which is what Contexts persist).
 *
 * `Storage.setCookies` accepts an array of `Network.CookieParam` entries —
 * a near-1:1 of the CookieInput shape, sans the (size, session) fields the
 * CDP parameter type doesn't carry.
 */
async function injectCookies(
  session: CdpSession,
  cookies: CookieInput[],
): Promise<void> {
  if (cookies.length === 0) return
  // CDP's Network.CookieParam shape — strip our extra fields (size, session)
  // since CDP rejects unknown keys. `expires` is a Unix epoch in seconds; -1
  // means session cookie (omit the field).
  const params = cookies.map((c) => {
    const out: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
    }
    if (c.expires > 0) out.expires = c.expires
    if (c.sameSite) out.sameSite = c.sameSite
    return out
  })
  // Use the browser-level `Storage.setCookies` — `Network.setCookies` is a
  // target-attached command and fails on the root client with "wasn't found".
  // `Storage.setCookies` writes into the browser's cookie store directly,
  // which is what Browserbase Contexts persist across sessions.
  await (session.client as unknown as {
    send: (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>
  }).send('Storage.setCookies', { cookies: params })
}

async function injectLocalStorage(
  session: CdpSession,
  items: LocalStorageInput[],
): Promise<void> {
  if (items.length === 0) return
  const grouped = groupByOrigin(items)
  for (const [origin, originItems] of grouped) {
    // CDP `DOMStorage.setDOMStorageItem` is the per-key shape; we issue one
    // call per (origin, key, value) triple. (`Storage.setStorageItems`
    // doesn't exist in the protocol; this is the canonical injection path
    // — see ARCHITECTURE.md line 240's reference to "Storage.setStorageItems"
    // which conflated the two domains. The DOMStorage call is what works
    // against a fresh browser context with no page open.)
    for (const it of originItems) {
      await (session.client as unknown as {
        send: (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>
      }).send('DOMStorage.setDOMStorageItem', {
        storageId: { securityOrigin: origin, isLocalStorage: true },
        key: it.key,
        value: it.value,
      })
    }
  }
}

/**
 * Open a Browserbase session against the supplied Context, inject cookies
 * + (optional) localStorage via CDP, then stop the session cleanly so the
 * Context persists.
 *
 * The session is always stopped from a `finally` — if injection fails we
 * still want to release the Browserbase session even though the Context
 * won't have the new state.
 */
export async function syncCookiesToContext(
  input: SyncCookiesToContextInput,
  deps: SyncCookiesToContextDeps,
): Promise<SyncCookiesToContextResult> {
  const filtered = filterByDomains(input.cookies, input.domains)
  const localStorageItems = input.localStorage ?? []
  const domains = uniqueDomains(filtered)

  let bbSession: BrowserbaseSession | null = null
  let cdp: CdpSession | null = null
  try {
    bbSession = await deps.createSession({
      workspaceId: input.workspaceId,
      contextId: input.contextId,
      persist: true,
    })
    cdp = await deps.attach({ wsUrl: bbSession.cdpWsUrl })
    await injectCookies(cdp, filtered)
    await injectLocalStorage(cdp, localStorageItems)
  } finally {
    if (cdp) {
      await cdp.detach().catch(() => {})
    }
    if (bbSession) {
      await deps.stopSession(bbSession.sessionId).catch(() => {})
    }
  }

  return {
    injectedCookies: filtered.length,
    injectedItems: localStorageItems.length,
    domains,
  }
}

/**
 * Default DI bundle for production: real Browserbase + harness CDP attach.
 *
 * Lazy-import `@basics/harness` so consumers that only want the types from
 * this module (e.g. tests) don't pay the harness load cost.
 */
export async function defaultSyncDeps(): Promise<SyncCookiesToContextDeps> {
  const { attach } = await import('@basics/harness')
  return {
    attach: ({ wsUrl }) => attach({ wsUrl }),
    createSession: ({ workspaceId, contextId, persist }) =>
      createSessionWithContext({
        workspaceId,
        contextId,
        ...(persist !== undefined ? { persist } : {}),
      }),
    stopSession: (sessionId) => stopSession(sessionId),
  }
}

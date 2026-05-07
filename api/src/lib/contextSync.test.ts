/**
 * Unit tests for `lib/contextSync.ts`. The CDP attach factory and the
 * Browserbase client are injected, so these tests don't touch real
 * Browserbase or spawn a Chrome.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CdpSession } from '@basics/harness'
import {
  syncCookiesToContext,
  type CookieInput,
  type LocalStorageInput,
  type SyncCookiesToContextDeps,
} from './contextSync.js'

interface FakeSendCall {
  method: string
  params: Record<string, unknown> | undefined
  sessionId: string | undefined
}

function makeFakeSession(): {
  session: CdpSession
  sends: FakeSendCall[]
  detached: { count: number }
} {
  const sends: FakeSendCall[] = []
  const detached = { count: 0 }
  const send = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => {
      sends.push({ method, params, sessionId })
      return {} as Record<string, unknown>
    },
  )
  // Minimal CdpSession surface — only the bits contextSync touches.
  const session = {
    client: { send } as unknown as CdpSession['client'],
    wsUrl: 'ws://fake',
    targetId: 'fake-target',
    sessionId: 'fake-session',
    events: [],
    pendingDialog: null,
    async detach() {
      detached.count++
    },
    async attachTarget() {
      return 'fake-session'
    },
  } as unknown as CdpSession
  return { session, sends, detached }
}

function baseCookie(overrides: Partial<CookieInput> = {}): CookieInput {
  return {
    name: 'sid',
    value: 'opaque',
    domain: '.example.com',
    path: '/',
    expires: 1_999_999_999,
    size: 32,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: 'Lax',
    ...overrides,
  }
}

function makeDeps(
  overrides: Partial<SyncCookiesToContextDeps> = {},
): {
  deps: SyncCookiesToContextDeps
  attachCalls: { wsUrl: string }[]
  sessionCalls: {
    workspaceId: string
    contextId: string
    persist?: boolean
  }[]
  stopCalls: string[]
  fakeSession: ReturnType<typeof makeFakeSession>
} {
  const fakeSession = makeFakeSession()
  const attachCalls: { wsUrl: string }[] = []
  const sessionCalls: {
    workspaceId: string
    contextId: string
    persist?: boolean
  }[] = []
  const stopCalls: string[] = []
  const deps: SyncCookiesToContextDeps = {
    attach: async ({ wsUrl }) => {
      attachCalls.push({ wsUrl })
      return fakeSession.session
    },
    createSession: async (opts) => {
      sessionCalls.push(opts)
      return {
        sessionId: 'bb-session-1',
        liveUrl: '',
        cdpWsUrl: 'wss://browserbase.example/cdp',
      }
    },
    stopSession: async (sessionId) => {
      stopCalls.push(sessionId)
    },
    ...overrides,
  }
  return { deps, attachCalls, sessionCalls, stopCalls, fakeSession }
}

describe('syncCookiesToContext', () => {
  it('boots a session with persist=true, attaches CDP, stops cleanly', async () => {
    const { deps, attachCalls, sessionCalls, stopCalls } = makeDeps()
    await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [baseCookie()],
      },
      deps,
    )
    expect(sessionCalls).toEqual([
      { workspaceId: 'ws-1', contextId: 'bb-ctx-1', persist: true },
    ])
    expect(attachCalls).toEqual([{ wsUrl: 'wss://browserbase.example/cdp' }])
    expect(stopCalls).toEqual(['bb-session-1'])
  })

  it('issues Storage.setCookies with the CDP-shaped payload', async () => {
    const { deps, fakeSession } = makeDeps()
    await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [
          baseCookie({ name: 'a', value: 'A' }),
          baseCookie({ name: 'b', value: 'B', domain: '.other.com' }),
        ],
      },
      deps,
    )
    const cookieSends = fakeSession.sends.filter(
      (s) => s.method === 'Storage.setCookies',
    )
    expect(cookieSends).toHaveLength(1)
    const cookies = (cookieSends[0]!.params as { cookies: unknown[] }).cookies
    expect(cookies).toHaveLength(2)
    // Verify the params shape — Network.CookieParam strips `size`/`session`.
    const first = cookies[0] as Record<string, unknown>
    expect(first.name).toBe('a')
    expect(first.value).toBe('A')
    expect(first.domain).toBe('.example.com')
    expect(first.size).toBeUndefined()
    expect(first.session).toBeUndefined()
    // Browser-level command — no sessionId.
    expect(cookieSends[0]!.sessionId).toBeUndefined()
  })

  it('omits expires when the input is -1 (session cookie)', async () => {
    const { deps, fakeSession } = makeDeps()
    await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [baseCookie({ expires: -1 })],
      },
      deps,
    )
    const cookieSends = fakeSession.sends.filter(
      (s) => s.method === 'Storage.setCookies',
    )
    const cookies = (cookieSends[0]!.params as { cookies: unknown[] }).cookies
    const first = cookies[0] as Record<string, unknown>
    expect(first.expires).toBeUndefined()
  })

  it('skips Storage.setCookies entirely when the cookie list is empty', async () => {
    const { deps, fakeSession } = makeDeps()
    const result = await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [],
      },
      deps,
    )
    expect(result.injectedCookies).toBe(0)
    const cookieSends = fakeSession.sends.filter(
      (s) => s.method === 'Storage.setCookies',
    )
    expect(cookieSends).toHaveLength(0)
  })

  it('filters cookies by include-domains (match by suffix)', async () => {
    const { deps, fakeSession } = makeDeps()
    const result = await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [
          baseCookie({ name: 'sf', domain: '.salesforce.com' }),
          baseCookie({ name: 'login', domain: 'login.salesforce.com' }),
          baseCookie({ name: 'evil', domain: 'evilsalesforce.com' }),
          baseCookie({ name: 'other', domain: '.other.com' }),
        ],
        domains: ['salesforce.com'],
      },
      deps,
    )
    expect(result.injectedCookies).toBe(2)
    expect(result.domains).toEqual(['login.salesforce.com', 'salesforce.com'])
    const cookieSends = fakeSession.sends.filter(
      (s) => s.method === 'Storage.setCookies',
    )
    const cookies = (cookieSends[0]!.params as { cookies: unknown[] }).cookies
    const names = cookies.map((c) => (c as Record<string, unknown>).name)
    expect(names).toEqual(['sf', 'login'])
  })

  it('passes cookies through unfiltered when domains is undefined', async () => {
    const { deps } = makeDeps()
    const result = await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [
          baseCookie({ domain: '.salesforce.com' }),
          baseCookie({ domain: '.hubspot.com' }),
        ],
      },
      deps,
    )
    expect(result.injectedCookies).toBe(2)
  })

  it('reports the deduped sorted domain list in the result', async () => {
    const { deps } = makeDeps()
    const result = await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [
          baseCookie({ domain: '.salesforce.com' }),
          baseCookie({ domain: 'salesforce.com' }),
          baseCookie({ domain: '.hubspot.com' }),
          baseCookie({ domain: '.hubspot.com' }),
        ],
      },
      deps,
    )
    expect(result.domains).toEqual(['hubspot.com', 'salesforce.com'])
  })

  it('injects localStorage as one DOMStorage.setDOMStorageItem per (origin, key)', async () => {
    const { deps, fakeSession } = makeDeps()
    const ls: LocalStorageInput[] = [
      {
        securityOrigin: 'https://salesforce.com',
        key: 'token',
        value: 'tok-1',
      },
      {
        securityOrigin: 'https://salesforce.com',
        key: 'theme',
        value: 'dark',
      },
      { securityOrigin: 'https://hubspot.com', key: 'sid', value: 'sid-1' },
    ]
    const result = await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [],
        localStorage: ls,
      },
      deps,
    )
    expect(result.injectedItems).toBe(3)
    const lsSends = fakeSession.sends.filter(
      (s) => s.method === 'DOMStorage.setDOMStorageItem',
    )
    expect(lsSends).toHaveLength(3)
    const keys = lsSends.map(
      (s) => (s.params as Record<string, unknown>).key,
    )
    expect(keys).toEqual(['token', 'theme', 'sid'])
  })

  it('skips DOMStorage calls when localStorage is empty/undefined', async () => {
    const { deps, fakeSession } = makeDeps()
    await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [baseCookie()],
      },
      deps,
    )
    const lsSends = fakeSession.sends.filter(
      (s) => s.method === 'DOMStorage.setDOMStorageItem',
    )
    expect(lsSends).toHaveLength(0)
  })

  it('always stops the Browserbase session even when CDP injection fails', async () => {
    const { deps, stopCalls, fakeSession } = makeDeps()
    // Make Storage.setCookies throw.
    ;(fakeSession.session.client as unknown as {
      send: (method: string) => Promise<unknown>
    }).send = vi.fn(async (method: string) => {
      if (method === 'Storage.setCookies') throw new Error('CDP boom')
      return {}
    })
    await expect(
      syncCookiesToContext(
        {
          workspaceId: 'ws-1',
          contextId: 'bb-ctx-1',
          cookies: [baseCookie()],
        },
        deps,
      ),
    ).rejects.toThrow('CDP boom')
    expect(stopCalls).toEqual(['bb-session-1'])
  })

  it('detaches the CDP session in finally even when stopSession also fails', async () => {
    const { fakeSession } = makeDeps()
    const deps: SyncCookiesToContextDeps = {
      attach: async () => fakeSession.session,
      createSession: async () => ({
        sessionId: 'bb-session-2',
        liveUrl: '',
        cdpWsUrl: 'wss://example/cdp',
      }),
      stopSession: async () => {
        throw new Error('stop boom')
      },
    }
    // Make the cookie call throw to drive both finally branches.
    ;(fakeSession.session.client as unknown as {
      send: (method: string) => Promise<unknown>
    }).send = vi.fn(async () => {
      throw new Error('cdp boom')
    })
    await expect(
      syncCookiesToContext(
        {
          workspaceId: 'ws-1',
          contextId: 'bb-ctx-1',
          cookies: [baseCookie()],
        },
        deps,
      ),
    ).rejects.toThrow('cdp boom')
    expect(fakeSession.detached.count).toBe(1)
  })

  it('passes the session ws url from createSession through to attach', async () => {
    const { fakeSession } = makeDeps()
    const seenAttach: string[] = []
    const deps: SyncCookiesToContextDeps = {
      attach: async ({ wsUrl }) => {
        seenAttach.push(wsUrl)
        return fakeSession.session
      },
      createSession: async () => ({
        sessionId: 'bb-session-3',
        liveUrl: '',
        cdpWsUrl: 'wss://example/cdp/abc',
      }),
      stopSession: async () => {},
    }
    await syncCookiesToContext(
      {
        workspaceId: 'ws-1',
        contextId: 'bb-ctx-1',
        cookies: [baseCookie()],
      },
      deps,
    )
    expect(seenAttach).toEqual(['wss://example/cdp/abc'])
  })
})

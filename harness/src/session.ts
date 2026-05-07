/**
 * CDP session lifecycle.
 *
 * Owns the `chrome-remote-interface` client, attaches to a real page target,
 * enables the default domains (Page/DOM/Runtime/Network), and installs an
 * event tap that mirrors the Python daemon's behavior:
 *
 *   - bounded ring buffer of recent CDP events (consumed by
 *     `wait_for_network_idle`)
 *   - tracks the currently open native dialog (consumed by `page_info`)
 *
 * Source: daemon.py:180–257 (initial attach + event tap + domain enables).
 */

import CDP from 'chrome-remote-interface'
import type { AttachOptions, CdpSession, PageDialog } from './types.js'
import { INTERNAL_URL_PREFIXES, markTab } from './internal.js'

const DEFAULT_BUFFER = 500

/** Domains we enable on every CDP session — see daemon.py:206–228. */
const DEFAULT_DOMAINS = ['Page', 'DOM', 'Runtime', 'Network'] as const

/**
 * Structural shape we use for the underlying CRI client. Mirrors
 * @types/chrome-remote-interface@0.33 — `send(method, params?, sessionId?)`
 * is positional, not an object. We intentionally widen `method` to
 * `string` because the helper layer accepts arbitrary CDP method names.
 */
interface CdpClientLike {
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<Record<string, unknown>>
  on: (event: string, listener: (...args: unknown[]) => void) => void
  close: () => Promise<void>
}

function asLike(client: unknown): CdpClientLike {
  return client as CdpClientLike
}

function isInternal(url: string): boolean {
  for (const p of INTERNAL_URL_PREFIXES) {
    if (url.startsWith(p)) return true
  }
  return false
}

async function send(
  client: CdpClientLike,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  return sessionId
    ? client.send(method, params ?? {}, sessionId)
    : client.send(method, params ?? {})
}

async function enableDefaultDomains(client: CdpClientLike, sessionId: string): Promise<void> {
  // Run the four enables in parallel — daemon.py:220–228 motivates this:
  // worst-case time should be a single CDP round trip, not four sequential.
  await Promise.all(
    DEFAULT_DOMAINS.map(async (d) => {
      try {
        await send(client, `${d}.enable`, {}, sessionId)
      } catch {
        // Some remotes lock down individual enables (e.g. Network on a
        // service-worker target). Best-effort — mirrors Python's swallow.
      }
    }),
  )
}

async function attachFirstPage(
  client: CdpClientLike,
): Promise<{ targetId: string; sessionId: string }> {
  const list = (await send(client, 'Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url?: string }>
  }

  const pages = list.targetInfos.filter((t) => t.type === 'page' && !isInternal(t.url ?? ''))

  let targetId: string
  if (pages.length === 0) {
    const created = (await send(client, 'Target.createTarget', { url: 'about:blank' })) as {
      targetId: string
    }
    targetId = created.targetId
  } else {
    targetId = pages[0]!.targetId
  }

  const attached = (await send(client, 'Target.attachToTarget', { targetId, flatten: true })) as {
    sessionId: string
  }

  await enableDefaultDomains(client, attached.sessionId)
  return { targetId, sessionId: attached.sessionId }
}

/**
 * Open a CDP connection, attach to a real page, enable the default domains,
 * and start the event tap. Returns a fully-initialized `CdpSession`.
 *
 * @source daemon.py:230–257 (`Daemon.start` + event tap)
 */
export async function attach(opts: AttachOptions): Promise<CdpSession> {
  const bufferSize = opts.eventBufferSize ?? DEFAULT_BUFFER

  // chrome-remote-interface treats `target` as either a string id or a
  // full URL — Browserbase / DevTools WS URLs (`ws://...`) are passed
  // straight through. `local: true` skips CRI's default HTTP probe to
  // `/json/version` on the host, which is required for Browserbase: their
  // wss endpoint does not respond to plain HTTP and the probe hangs the
  // socket. With `local: true`, CRI uses its bundled protocol descriptor
  // and opens the WebSocket directly.
  const client = asLike(await CDP({ target: opts.wsUrl, local: true }))

  let attached: { targetId: string; sessionId: string }
  try {
    attached = await attachFirstPage(client)
  } catch (e) {
    await client.close().catch(() => {})
    throw e
  }

  const events: CdpSession['events'] = []

  const session: CdpSession = {
    client: client as unknown as CdpSession['client'],
    wsUrl: opts.wsUrl,
    targetId: attached.targetId,
    sessionId: attached.sessionId,
    events,
    pendingDialog: null,
    async detach() {
      await client.close().catch(() => {})
    },
    async attachTarget(newTargetId: string) {
      // Best-effort: disable Network on the old session so background tab
      // traffic stops flooding the buffer (daemon.py:303–312). The
      // wait_for_network_idle filter is the actual correctness gate, but
      // this keeps the buffer focused.
      const oldSessionId = this.sessionId
      if (oldSessionId) {
        try {
          await send(client, 'Network.disable', {}, oldSessionId)
        } catch {
          /* ignore */
        }
      }
      const attachedNew = (await send(client, 'Target.attachToTarget', {
        targetId: newTargetId,
        flatten: true,
      })) as { sessionId: string }
      this.targetId = newTargetId
      this.sessionId = attachedNew.sessionId
      await enableDefaultDomains(client, attachedNew.sessionId)
      // Cosmetic tab marker — fire-and-forget, matches daemon.py:317–324.
      markTab(this).catch(() => {})
      return attachedNew.sessionId
    },
  }

  // Event tap. chrome-remote-interface emits a generic 'event' for every
  // CDP message that isn't a command response. Each event carries
  // `{ method, params, sessionId? }`. Mirrors daemon.py:248–257.
  client.on('event', ((message: unknown) => {
    const m = message as { method?: string; params?: Record<string, unknown>; sessionId?: string }
    if (!m || typeof m.method !== 'string') return
    const evt = {
      method: m.method,
      params: (m.params ?? {}) as Record<string, unknown>,
      sessionId: m.sessionId,
    }
    events.push(evt)
    while (events.length > bufferSize) events.shift()

    if (evt.method === 'Page.javascriptDialogOpening') {
      session.pendingDialog = evt.params as PageDialog['dialog']
    } else if (evt.method === 'Page.javascriptDialogClosed') {
      session.pendingDialog = null
    } else if (evt.method === 'Page.loadEventFired' || evt.method === 'Page.domContentEventFired') {
      // Re-mark the tab on every navigation (the title resets across loads).
      markTab(session).catch(() => {})
    }
  }) as (...args: unknown[]) => void)

  // Initial mark.
  markTab(session).catch(() => {})

  return session
}

/**
 * Close the underlying CDP connection. Idempotent; safe to call twice.
 *
 * @source daemon.py:370–375 (`serve` cleanup)
 */
export async function detach(session: CdpSession): Promise<void> {
  await session.detach()
}

/** Re-export the helper that flips default domains on a fresh session id. */
export { enableDefaultDomains }

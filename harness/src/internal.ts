/**
 * Internal helpers ported from `helpers.py`.
 *
 * These are the building blocks the public helpers depend on — JS evaluation,
 * exception decoding, and `return`-statement detection. The daemon/IPC and
 * env-loading helpers are intentionally NOT ported (we don't have a daemon).
 *
 * Source: helpers.py:42–155 (private helpers).
 */

import type { CdpSession } from './types.js'

/**
 * Send a raw CDP command on the active session.
 *
 * Browser-level `Target.*` calls must NOT carry a session id (they target
 * the root browser, not a specific page session). Everything else uses
 * `session.sessionId`. Mirrors daemon.py:329–342.
 *
 * @source helpers.py:52–54 (`cdp`)
 */
export async function cdp(
  session: CdpSession,
  method: string,
  params: Record<string, unknown> = {},
  opts: { sessionId?: string | null } = {},
): Promise<Record<string, unknown>> {
  const isBrowserScoped = method.startsWith('Target.')
  const sid =
    opts.sessionId === null
      ? undefined
      : opts.sessionId !== undefined
        ? opts.sessionId
        : isBrowserScoped
          ? undefined
          : session.sessionId

  // chrome-remote-interface: client.send(method, params?, sessionId?) -> Promise<result>.
  // The library types method as a literal union of CDP method names; we accept arbitrary
  // strings (mirrors helpers.py:52 `cdp(method, ...)`), so we cast to a structural callable.
  const send = (
    session.client as unknown as {
      send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>
    }
  ).send.bind(session.client)

  const result = sid
    ? await send(method, params, sid)
    : await send(method, params)
  return result ?? {}
}

/**
 * Drain and clear the event buffer. Returns the events that were buffered
 * since the last drain. The buffer is bounded; older events are dropped.
 *
 * @source helpers.py:57 (`drain_events`) + daemon.py:272–274
 */
export function drainEvents(session: CdpSession): Array<{
  method: string
  params: Record<string, unknown>
  sessionId: string | undefined
}> {
  const out = session.events.slice()
  session.events.length = 0
  return out
}

/**
 * Truncate a JS expression for inclusion in error messages. Replaces newlines
 * and caps at `limit` characters, appending `...` when truncated.
 *
 * @source helpers.py:60–62 (`_js_snippet`)
 */
export function jsSnippet(expression: string, limit: number = 160): string {
  const snippet = expression.trim().replace(/\n/g, '\\n')
  return snippet.length > limit ? snippet.slice(0, limit - 3) + '...' : snippet
}

/**
 * Build the human-readable description for a Runtime.evaluate failure,
 * walking exception details / value / className fallbacks.
 *
 * @source helpers.py:65–76 (`_js_exception_description`)
 */
export function jsExceptionDescription(
  result: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
): string {
  let desc: unknown = result?.description
  const exc = details && typeof details === 'object' ? (details.exception as Record<string, unknown> | undefined) : undefined
  if (!desc && exc && typeof exc === 'object') {
    desc = exc.description
    if (desc === undefined && 'value' in exc) {
      desc = String(exc.value)
    }
    if (desc === undefined) {
      desc = exc.className
    }
  }
  if (!desc && details) {
    desc = details.text
  }
  return typeof desc === 'string' && desc ? desc : 'JavaScript evaluation failed'
}

/**
 * Decode CDP's "unserializable" Runtime.RemoteObject value markers
 * (NaN, Infinity, -Infinity, -0, BigInt suffix `n`).
 *
 * @source helpers.py:79–90 (`_decode_unserializable_js_value`)
 */
export function decodeUnserializableJsValue(value: string): number | bigint | string {
  if (value === 'NaN') return Number.NaN
  if (value === 'Infinity') return Number.POSITIVE_INFINITY
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY
  if (value === '-0') return -0
  if (value.endsWith('n')) {
    try {
      return BigInt(value.slice(0, -1))
    } catch {
      return value
    }
  }
  return value
}

/**
 * Extract the value from a `Runtime.evaluate` response, raising on errors.
 * Mirrors helpers.py exactly: structured `value` wins, then unserializable,
 * then null.
 *
 * @source helpers.py:93–109 (`_runtime_value`)
 */
export function runtimeValue(response: Record<string, unknown>, expression: string): unknown {
  const result = (response.result as Record<string, unknown> | undefined) ?? {}
  const details = response.exceptionDetails as Record<string, unknown> | undefined
  const subtype = result.subtype
  if (details || subtype === 'error') {
    const desc = jsExceptionDescription(result, details)
    let loc = ''
    if (details) {
      const line = details.lineNumber as number | undefined
      const col = details.columnNumber as number | undefined
      if (line !== undefined && col !== undefined) {
        loc = ` at line ${line}, column ${col}`
      }
    }
    throw new Error(`JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`)
  }
  if ('value' in result) {
    return result.value
  }
  if ('unserializableValue' in result) {
    return decodeUnserializableJsValue(String(result.unserializableValue))
  }
  return null
}

/**
 * `Runtime.evaluate` wrapper that returns a usable JS value (not the wire
 * envelope). Sets `returnByValue: true` so deep structures come back without
 * a separate Runtime.getProperties round trip.
 *
 * @source helpers.py:112–117 (`_runtime_evaluate`)
 */
export async function runtimeEvaluate(
  session: CdpSession,
  expression: string,
  opts: { sessionId?: string | null; awaitPromise?: boolean } = {},
): Promise<unknown> {
  let response: Record<string, unknown>
  try {
    response = await cdp(
      session,
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? false,
      },
      { sessionId: opts.sessionId },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Runtime.evaluate failed; expression: ${jsSnippet(expression)}: ${msg}`)
  }
  return runtimeValue(response, expression)
}

/**
 * Detect a top-level `return` keyword while ignoring strings and comments.
 * Used by `js()` to decide whether to wrap an expression in an IIFE.
 *
 * Direct char-by-char port of the Python state machine — no regex, because
 * that's how the original handles edge cases like `"return"` in a string.
 *
 * @source helpers.py:120–155 (`_has_return_statement`)
 */
export function hasReturnStatement(expression: string): boolean {
  const n = expression.length
  let i = 0
  let state: 'code' | 'line_comment' | 'block_comment' | 'string' = 'code'
  let quote = ''

  const isAlnum = (ch: string): boolean => /[A-Za-z0-9]/.test(ch)

  while (i < n) {
    const ch = expression[i] ?? ''
    const nxt = i + 1 < n ? (expression[i + 1] ?? '') : ''

    if (state === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') {
        state = 'string'
        quote = ch
        i += 1
        continue
      }
      if (ch === '/' && nxt === '/') {
        state = 'line_comment'
        i += 2
        continue
      }
      if (ch === '/' && nxt === '*') {
        state = 'block_comment'
        i += 2
        continue
      }
      if (expression.startsWith('return', i)) {
        const before = i > 0 ? (expression[i - 1] ?? '') : ''
        const after = i + 6 < n ? (expression[i + 6] ?? '') : ''
        const beforeOk = !(before === '_' || isAlnum(before))
        const afterOk = !(after === '_' || isAlnum(after))
        if (beforeOk && afterOk) return true
      }
      i += 1
      continue
    }
    if (state === 'line_comment') {
      if (ch === '\n') state = 'code'
      i += 1
      continue
    }
    if (state === 'block_comment') {
      if (ch === '*' && nxt === '/') {
        state = 'code'
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (state === 'string') {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) {
        state = 'code'
        quote = ''
      }
      i += 1
      continue
    }
  }
  return false
}

/**
 * Mark a tab title with a green-circle emoji prefix so the user can tell
 * which tab the agent controls. Best-effort; failures are swallowed.
 *
 * @source helpers.py:298–301 (`_mark_tab`) + daemon.py:247
 */
export async function markTab(session: CdpSession, sessionId?: string): Promise<void> {
  try {
    await cdp(
      session,
      'Runtime.evaluate',
      { expression: "if(!document.title.startsWith('\u{1F7E2}'))document.title='\u{1F7E2} '+document.title" },
      { sessionId: sessionId ?? session.sessionId },
    )
  } catch {
    // Best-effort cosmetic, ignored.
  }
}

/**
 * Drop the green-circle prefix from the current tab's title, if present.
 * Used right before switching tabs so only one tab carries the marker at
 * a time.
 *
 * @source helpers.py:307–309 (inside `switch_tab`)
 */
export async function unmarkTab(session: CdpSession, sessionId?: string): Promise<void> {
  try {
    await cdp(
      session,
      'Runtime.evaluate',
      { expression: "if(document.title.startsWith('\u{1F7E2} '))document.title=document.title.slice(2)" },
      { sessionId: sessionId ?? session.sessionId },
    )
  } catch {
    // Best-effort cosmetic, ignored.
  }
}

/** URL prefixes considered "internal" / non-user tabs. */
export const INTERNAL_URL_PREFIXES: readonly string[] = [
  'chrome://',
  'chrome-untrusted://',
  'devtools://',
  'chrome-extension://',
  'about:',
]

export function isInternalUrl(url: string): boolean {
  for (const p of INTERNAL_URL_PREFIXES) {
    if (url.startsWith(p)) return true
  }
  return false
}

/** JSON.stringify a string value as a JS literal — for safe interpolation into JS expressions. */
export function jsLiteral(value: string): string {
  return JSON.stringify(value)
}

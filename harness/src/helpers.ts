/**
 * Public CDP helpers.
 *
 * Direct port of `helpers.py`. Each public function carries a `@source`
 * line range so the port can be audited line-by-line against the original.
 *
 * Design rule (per ARCHITECTURE.md): pure functions over a `CdpSession`
 * handle. No globals, no daemon, no IPC — the caller owns the session.
 */

import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import {
  cdp,
  drainEvents,
  hasReturnStatement,
  isInternalUrl,
  jsLiteral,
  markTab,
  runtimeEvaluate,
  unmarkTab,
} from './internal.js'
import type {
  CdpSession,
  CurrentTabInfo,
  HttpGetResult,
  KeyDescriptor,
  KeyModifiers,
  MouseButton,
  PageInfoResult,
  ScreenshotOptions,
  ScreenshotResult,
  TabInfo,
} from './types.js'

// =============================================================================
// navigation / page
// =============================================================================

/**
 * Navigate the active tab to `url`. Returns the raw `Page.navigate` result
 * (frameId, loaderId, errorText?).
 *
 * The Python helper conditionally appends `domain_skills` from a workspace
 * directory when `BH_DOMAIN_SKILLS=1`. That is an agent-runtime concern and
 * is intentionally not ported.
 *
 * @source helpers.py:159–164 (`goto_url`)
 */
export async function goto_url(session: CdpSession, url: string): Promise<Record<string, unknown>> {
  return cdp(session, 'Page.navigate', { url })
}

/**
 * Snapshot of the active tab — URL, title, viewport size, scroll position,
 * and full page size. Returns `{ dialog }` instead if a native dialog is
 * open (the page's JS thread is frozen until the caller handles it).
 *
 * @source helpers.py:166–176 (`page_info`)
 */
export async function page_info(session: CdpSession): Promise<PageInfoResult> {
  if (session.pendingDialog) {
    return { dialog: session.pendingDialog }
  }
  const expression =
    'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})'
  const raw = await runtimeEvaluate(session, expression)
  return JSON.parse(String(raw)) as PageInfoResult
}

// =============================================================================
// input
// =============================================================================

/**
 * Synthesize a mouse press + release at viewport coordinates `(x, y)`.
 * `clicks` becomes the CDP `clickCount` for double/triple click runs.
 *
 * The Python `BH_DEBUG_CLICKS` Pillow overlay path is intentionally NOT
 * ported — it's a host-side debugging aid, not a CDP feature.
 *
 * @source helpers.py:181–201 (`click_at_xy`)
 */
export async function click_at_xy(
  session: CdpSession,
  x: number,
  y: number,
  button: MouseButton = 'left',
  clicks: number = 1,
): Promise<void> {
  await cdp(session, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount: clicks,
  })
  await cdp(session, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount: clicks,
  })
}

/**
 * Insert literal text at the current focus via `Input.insertText`. Bypasses
 * key events — see `fill_input` for framework-managed inputs.
 *
 * @source helpers.py:203–204 (`type_text`)
 */
export async function type_text(session: CdpSession, text: string): Promise<void> {
  await cdp(session, 'Input.insertText', { text })
}

/**
 * Fill a framework-managed input (React controlled, Vue v-model, Ember
 * tracked). Focuses the element, optionally clears it, types via real key
 * events, then fires synthetic `input` and `change` events so the framework
 * sees the update.
 *
 * Throws if the element is not found. Pass `timeout > 0` to wait for
 * late-rendered elements before typing.
 *
 * @source helpers.py:206–243 (`fill_input`)
 */
export async function fill_input(
  session: CdpSession,
  selector: string,
  text: string,
  clearFirst: boolean = true,
  timeout: number = 0,
): Promise<void> {
  if (timeout > 0) {
    const found = await wait_for_element(session, selector, timeout)
    if (!found) {
      throw new Error(`fill_input: element not found: ${JSON.stringify(selector)}`)
    }
  }

  const focused = await js(
    session,
    `(()=>{const e=document.querySelector(${jsLiteral(selector)});if(!e)return false;e.focus();return true;})()`,
  )
  if (!focused) {
    throw new Error(`fill_input: element not found: ${JSON.stringify(selector)}`)
  }

  if (clearFirst) {
    // Dispatch select-all directly — NOT via press_key. press_key always
    // emits a `char` event for single-char keys; with Ctrl/Cmd held that
    // makes Chrome treat the input as a printable "a" instead of firing
    // the select-all shortcut.
    const mods: KeyModifiers = process.platform === 'darwin' ? 4 /* Meta */ : 2 /* Ctrl */
    const selectAll = {
      key: 'a',
      code: 'KeyA',
      modifiers: mods,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    }
    await cdp(session, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll })
    await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll })
    await press_key(session, 'Backspace')
  }

  for (const ch of text) {
    await press_key(session, ch)
  }

  await js(
    session,
    `(()=>{const e=document.querySelector(${jsLiteral(selector)});if(!e)return;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})();`,
  )
}

/** Special key descriptors. Mirrors helpers.py:245–252 verbatim. */
const KEYS: Record<string, KeyDescriptor> = {
  Enter: [13, 'Enter', '\r'],
  Tab: [9, 'Tab', '\t'],
  Backspace: [8, 'Backspace', ''],
  Escape: [27, 'Escape', ''],
  Delete: [46, 'Delete', ''],
  ' ': [32, 'Space', ' '],
  ArrowLeft: [37, 'ArrowLeft', ''],
  ArrowUp: [38, 'ArrowUp', ''],
  ArrowRight: [39, 'ArrowRight', ''],
  ArrowDown: [40, 'ArrowDown', ''],
  Home: [36, 'Home', ''],
  End: [35, 'End', ''],
  PageUp: [33, 'PageUp', ''],
  PageDown: [34, 'PageDown', ''],
}

/**
 * Send a complete keyDown -> (char) -> keyUp sequence for `key`. Special
 * keys (Enter, Tab, Arrow*, Backspace, etc.) carry their virtual key codes
 * so listeners checking `e.keyCode` / `e.key` all fire.
 *
 * Modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift.
 *
 * @source helpers.py:253–262 (`press_key`)
 */
export async function press_key(
  session: CdpSession,
  key: string,
  modifiers: KeyModifiers = 0,
): Promise<void> {
  const known = KEYS[key]
  let vk: number
  let code: string
  let text: string
  if (known) {
    ;[vk, code, text] = known
  } else if (key.length === 1) {
    vk = key.charCodeAt(0)
    code = key
    text = key
  } else {
    vk = 0
    code = key
    text = ''
  }

  const base: Record<string, unknown> = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  }

  const downParams: Record<string, unknown> = { type: 'keyDown', ...base }
  if (text) downParams.text = text
  await cdp(session, 'Input.dispatchKeyEvent', downParams)

  if (text && text.length === 1) {
    await cdp(session, 'Input.dispatchKeyEvent', {
      type: 'char',
      text,
      ...base,
    })
  }

  await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * Synthesize a mouse-wheel event at `(x, y)`. Default `dy = -300` scrolls
 * the page upward by ~300 CSS pixels (CDP wheel uses negative-up convention).
 *
 * @source helpers.py:264–265 (`scroll`)
 */
export async function scroll(
  session: CdpSession,
  x: number,
  y: number,
  dy: number = -300,
  dx: number = 0,
): Promise<void> {
  await cdp(session, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: dx,
    deltaY: dy,
  })
}

// =============================================================================
// visual
// =============================================================================

/**
 * Capture a PNG of the active tab. Returns the base64 payload and (if a
 * `path` is supplied) writes the bytes to disk.
 *
 * Set `full: true` to capture beyond the viewport (full-page screenshot).
 * The Python helper's optional Pillow `max_dim` thumbnail step is not
 * ported — image post-processing belongs at the call site.
 *
 * @source helpers.py:269–281 (`capture_screenshot`)
 */
export async function capture_screenshot(
  session: CdpSession,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const format: 'png' | 'jpeg' = opts.format ?? 'png'
  const result = await cdp(session, 'Page.captureScreenshot', {
    format,
    captureBeyondViewport: opts.full ?? false,
  })
  const data = String((result as { data?: string }).data ?? '')

  let path: string | undefined
  if (opts.path) {
    await writeFile(opts.path, Buffer.from(data, 'base64'))
    path = opts.path
  }

  const out: ScreenshotResult = { base64: data, format }
  if (path) out.path = path
  return out
}

// =============================================================================
// tabs
// =============================================================================

/**
 * List all page-type targets (browser tabs). Set `includeChrome=false` to
 * filter out chrome:// / devtools:// / about: / extension pages.
 *
 * @source helpers.py:285–292 (`list_tabs`)
 */
export async function list_tabs(session: CdpSession, includeChrome: boolean = true): Promise<TabInfo[]> {
  const r = (await cdp(session, 'Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; title?: string; url?: string }>
  }
  const out: TabInfo[] = []
  for (const t of r.targetInfos) {
    if (t.type !== 'page') continue
    const url = t.url ?? ''
    if (!includeChrome && isInternalUrl(url)) continue
    out.push({ targetId: t.targetId, title: t.title ?? '', url })
  }
  return out
}

/**
 * Info about the currently attached target.
 *
 * @source helpers.py:294–296 (`current_tab`)
 */
export async function current_tab(session: CdpSession): Promise<CurrentTabInfo> {
  const r = (await cdp(session, 'Target.getTargetInfo', { targetId: session.targetId })) as {
    targetInfo?: { targetId?: string; url?: string; title?: string }
  }
  const t = r.targetInfo ?? {}
  return { targetId: t.targetId, url: t.url ?? '', title: t.title ?? '' }
}

/**
 * Switch the session to a different target. Accepts either a raw target id
 * string or any object with a `.targetId` property (so
 * `switch_tab(await current_tab(s))` works without manual unwrapping).
 *
 * Mirrors helpers.py:303–314: unmark old tab, activate new one, attach,
 * mark new tab. Returns the new CDP session id.
 *
 * @source helpers.py:303–314 (`switch_tab`)
 */
export async function switch_tab(
  session: CdpSession,
  target: string | { targetId?: string },
): Promise<string> {
  const targetId = typeof target === 'string' ? target : target.targetId
  if (!targetId) throw new Error('switch_tab: missing targetId')

  await unmarkTab(session)

  await cdp(session, 'Target.activateTarget', { targetId })
  const newSessionId = await session.attachTarget(targetId)
  return newSessionId
}

/**
 * Create a new tab. Always opens `about:blank` first then navigates,
 * matching the Python helper's race-avoidance comment: passing a real URL
 * to `Target.createTarget` races with attach so `wait_for_load` can return
 * before the navigation actually starts.
 *
 * @source helpers.py:316–324 (`new_tab`)
 */
export async function new_tab(session: CdpSession, url: string = 'about:blank'): Promise<string> {
  const created = (await cdp(session, 'Target.createTarget', { url: 'about:blank' })) as { targetId: string }
  const tid = created.targetId
  await switch_tab(session, tid)
  if (url !== 'about:blank') {
    await goto_url(session, url)
  }
  return tid
}

/**
 * Switch to a real user tab if the current target is internal (chrome://,
 * about:, etc.) or unreachable. Returns the surviving tab info, or null if
 * no real tabs exist.
 *
 * @source helpers.py:326–338 (`ensure_real_tab`)
 */
export async function ensure_real_tab(session: CdpSession): Promise<TabInfo | CurrentTabInfo | null> {
  const tabs = await list_tabs(session, false)
  if (tabs.length === 0) return null
  try {
    const cur = await current_tab(session)
    if (cur.url && !isInternalUrl(cur.url)) return cur
  } catch {
    // current_tab() can fail if the target is gone — fall through.
  }
  const first = tabs[0]!
  await switch_tab(session, first.targetId)
  return first
}

/**
 * Find the first iframe target whose URL contains `urlSubstr`. The returned
 * target id can be passed to `js(..., { targetId })` to evaluate inside
 * the iframe's isolated world.
 *
 * @source helpers.py:340–345 (`iframe_target`)
 */
export async function iframe_target(session: CdpSession, urlSubstr: string): Promise<string | null> {
  const r = (await cdp(session, 'Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url?: string }>
  }
  for (const t of r.targetInfos) {
    if (t.type === 'iframe' && (t.url ?? '').includes(urlSubstr)) {
      return t.targetId
    }
  }
  return null
}

// =============================================================================
// utility
// =============================================================================

/**
 * Sleep for `seconds`. Wall-clock — uses `setTimeout`.
 *
 * @source helpers.py:349–350 (`wait`)
 */
export function wait(seconds: number = 1.0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)))
}

/**
 * Block until `document.readyState === 'complete'` or `timeout` seconds
 * elapse. Polls every 300ms.
 *
 * Note: SPAs hit `complete` long before the framework finishes rendering —
 * use `wait_for_element` for post-render synchronisation.
 *
 * @source helpers.py:352–358 (`wait_for_load`)
 */
export async function wait_for_load(session: CdpSession, timeout: number = 15.0): Promise<boolean> {
  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    const state = await js(session, 'document.readyState')
    if (state === 'complete') return true
    await wait(0.3)
  }
  return false
}

/**
 * Poll until `querySelector(selector)` returns a node, or `timeout` seconds
 * elapse. Set `visible: true` to also require non-hidden + in-layout
 * (uses `Element.checkVisibility()` when available, falls back to a
 * computed-style check for older Chrome).
 *
 * @source helpers.py:360–388 (`wait_for_element`)
 */
export async function wait_for_element(
  session: CdpSession,
  selector: string,
  timeout: number = 10.0,
  visible: boolean = false,
): Promise<boolean> {
  const sel = jsLiteral(selector)
  let check: string
  if (visible) {
    check =
      `(()=>{const e=document.querySelector(${sel});` +
      `if(!e)return false;` +
      `if(typeof e.checkVisibility==='function')` +
      `return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});` +
      `const s=getComputedStyle(e);` +
      `return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'})()`
  } else {
    check = `!!document.querySelector(${sel})`
  }

  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    const found = await js(session, check)
    if (found) return true
    await wait(0.3)
  }
  return false
}

/**
 * Wait until all in-flight network requests finish AND no `Network.*`
 * events have fired for `idleMs` milliseconds. Returns true if the idle
 * window was reached, false on timeout.
 *
 * Filters events by `sessionId` so a previously-attached background tab
 * (polling/SSE) doesn't poison the idle check on the active tab —
 * mirrors the daemon.py:295–311 + helpers.py:401–423 reasoning.
 *
 * @source helpers.py:390–423 (`wait_for_network_idle`)
 */
export async function wait_for_network_idle(
  session: CdpSession,
  timeout: number = 10.0,
  idleMs: number = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeout * 1000
  let lastActivity = Date.now()
  const inflight = new Set<string>()
  const activeSession = session.sessionId

  while (Date.now() < deadline) {
    const events = drainEvents(session)
    for (const e of events) {
      if (e.sessionId !== activeSession) continue
      const method = e.method
      const params = e.params
      if (method === 'Network.requestWillBeSent') {
        const id = params.requestId as string | undefined
        if (id) inflight.add(id)
        lastActivity = Date.now()
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const id = params.requestId as string | undefined
        if (id) inflight.delete(id)
        lastActivity = Date.now()
      } else if (method.startsWith('Network.')) {
        lastActivity = Date.now()
      }
    }
    if (inflight.size === 0 && Date.now() - lastActivity >= idleMs) {
      return true
    }
    await wait(0.1)
  }
  return false
}

/**
 * Evaluate `expression` in the active tab (or in an iframe target if
 * `targetId` is given). Top-level `return` statements are auto-wrapped in
 * an IIFE so both `document.title` and `const x = 1; return x` work.
 *
 * Awaits returned Promises (`awaitPromise: true`).
 *
 * @source helpers.py:425–434 (`js`)
 */
export async function js(
  session: CdpSession,
  expression: string,
  opts: { targetId?: string } = {},
): Promise<unknown> {
  let sid: string | null | undefined
  if (opts.targetId) {
    const r = (await cdp(session, 'Target.attachToTarget', {
      targetId: opts.targetId,
      flatten: true,
    })) as { sessionId: string }
    sid = r.sessionId
  }

  let expr = expression
  if (hasReturnStatement(expr) && !expr.trim().startsWith('(')) {
    expr = `(function(){${expr}})()`
  }

  return runtimeEvaluate(session, expr, { sessionId: sid, awaitPromise: true })
}

/** Key code lookup for `dispatch_key`. Mirrors helpers.py:437. */
const KC: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  ' ': 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
}

/**
 * Dispatch a synthetic DOM `KeyboardEvent` on the matched element. Useful
 * when a site reacts to DOM-level key events on an element more reliably
 * than to raw CDP input events at viewport coordinates.
 *
 * @source helpers.py:440–449 (`dispatch_key`)
 */
export async function dispatch_key(
  session: CdpSession,
  selector: string,
  key: string = 'Enter',
  event: string = 'keypress',
): Promise<void> {
  const kc = KC[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0)
  const sel = jsLiteral(selector)
  const keyLit = jsLiteral(key)
  const eventLit = jsLiteral(event)
  await js(
    session,
    `(()=>{const e=document.querySelector(${sel});if(e){e.focus();e.dispatchEvent(new KeyboardEvent(${eventLit},{key:${keyLit},code:${keyLit},keyCode:${kc},which:${kc},bubbles:true}));}})()`,
  )
}

/**
 * Set files on a `<input type=file>` via `DOM.setFileInputFiles`. `path`
 * must be an absolute filepath (or array of paths) accessible to the
 * Chrome process.
 *
 * @source helpers.py:451–456 (`upload_file`)
 */
export async function upload_file(
  session: CdpSession,
  selector: string,
  path: string | string[],
): Promise<void> {
  const doc = (await cdp(session, 'DOM.getDocument', { depth: -1 })) as { root: { nodeId: number } }
  const q = (await cdp(session, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  })) as { nodeId: number }
  if (!q.nodeId) throw new Error(`no element for ${selector}`)
  const files = typeof path === 'string' ? [path] : path
  await cdp(session, 'DOM.setFileInputFiles', { files, nodeId: q.nodeId })
}

/**
 * Pure HTTP GET via Node's `fetch`. No browser involvement — useful for
 * static pages and APIs.
 *
 * The Python helper has an opt-in `BROWSER_USE_API_KEY` proxy path through
 * `fetch_use`. That is intentionally not ported here — it's a higher-level
 * concern and would be configured at the runtime layer.
 *
 * @source helpers.py:458–475 (`http_get`)
 */
export async function http_get(
  url: string,
  headers?: Record<string, string>,
  timeout: number = 20.0,
): Promise<HttpGetResult> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), Math.max(0, timeout * 1000))
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...(headers ?? {}),
      },
      signal: controller.signal,
    })
    const body = await res.text()
    const headerObj: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headerObj[k] = v
    })
    return {
      status: res.status,
      headers: headerObj,
      body,
    }
  } finally {
    clearTimeout(t)
  }
}

// Re-export the marker helpers under their snake-case names so callers
// who want them don't have to dig into ./internal.
export { markTab as _mark_tab, unmarkTab as _unmark_tab }

/**
 * Shape + unit tests for @basics/harness.
 *
 * Verifies (a) every helper is exported with the right callable shape and
 * (b) a handful of pure-logic helpers behave like the Python originals
 * against a hand-rolled mock CDP client.
 *
 * Real Chrome integration tests live in Phase 02 of runtime/.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  capture_screenshot,
  click_at_xy,
  current_tab,
  dispatch_key,
  ensure_real_tab,
  fill_input,
  goto_url,
  http_get,
  iframe_target,
  js,
  list_tabs,
  new_tab,
  page_info,
  press_key,
  scroll,
  switch_tab,
  type_text,
  upload_file,
  wait,
  wait_for_element,
  wait_for_load,
  wait_for_network_idle,
} from './helpers.js'
import { attach, detach } from './session.js'
import {
  cdp,
  decodeUnserializableJsValue,
  hasReturnStatement,
  isInternalUrl,
  jsLiteral,
  jsSnippet,
  runtimeValue,
} from './internal.js'
import type { CdpSession } from './types.js'

// ---------------------------------------------------------------------------
// Mock CDP session — no real WebSocket, no real Chrome.
// ---------------------------------------------------------------------------

interface SendCall {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

function mockSession(handler: (call: SendCall) => unknown): {
  session: CdpSession
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  // chrome-remote-interface's real signature: send(method, params?, sessionId?).
  // Positional, not an object — matches @types/chrome-remote-interface@0.33.
  const send = vi.fn(
    async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      const call: SendCall = { method, params }
      if (sessionId) call.sessionId = sessionId
      calls.push(call)
      return (handler(call) ?? {}) as Record<string, unknown>
    },
  )

  const session: CdpSession = {
    client: { send } as unknown as CdpSession['client'],
    wsUrl: 'ws://mock',
    targetId: 'TGT',
    sessionId: 'SES',
    events: [],
    pendingDialog: null,
    async detach() {},
    async attachTarget(newId: string) {
      this.targetId = newId
      this.sessionId = 'SES2'
      return 'SES2'
    },
  }
  return { session, calls }
}

// ---------------------------------------------------------------------------
// Pure helpers — ported logic.
// ---------------------------------------------------------------------------

describe('internal: hasReturnStatement', () => {
  it('detects bare top-level return', () => {
    expect(hasReturnStatement('const x = 1; return x')).toBe(true)
  })
  it('returns false for plain expression', () => {
    expect(hasReturnStatement('document.title')).toBe(false)
  })
  it('ignores return inside string literal', () => {
    expect(hasReturnStatement('"return"')).toBe(false)
    expect(hasReturnStatement('`return`')).toBe(false)
  })
  it('ignores return inside line comment', () => {
    expect(hasReturnStatement('// return\nx')).toBe(false)
  })
  it('ignores return inside block comment', () => {
    expect(hasReturnStatement('/* return */ x')).toBe(false)
  })
  it('rejects partial-word matches like "returner"', () => {
    expect(hasReturnStatement('returner()')).toBe(false)
  })
})

describe('internal: decodeUnserializableJsValue', () => {
  it('decodes NaN/Infinity/-Infinity/-0/BigInt', () => {
    expect(Number.isNaN(decodeUnserializableJsValue('NaN') as number)).toBe(true)
    expect(decodeUnserializableJsValue('Infinity')).toBe(Number.POSITIVE_INFINITY)
    expect(decodeUnserializableJsValue('-Infinity')).toBe(Number.NEGATIVE_INFINITY)
    expect(Object.is(decodeUnserializableJsValue('-0'), -0)).toBe(true)
    expect(decodeUnserializableJsValue('123n')).toBe(123n)
  })
})

describe('internal: jsSnippet', () => {
  it('truncates with ellipsis at the limit', () => {
    expect(jsSnippet('x'.repeat(200), 10)).toBe('xxxxxxx...')
  })
  it('replaces newlines', () => {
    expect(jsSnippet('a\nb')).toBe('a\\nb')
  })
})

describe('internal: runtimeValue', () => {
  it('returns plain values', () => {
    expect(runtimeValue({ result: { value: 42 } }, 'x')).toBe(42)
  })
  it('decodes unserializable values', () => {
    expect(runtimeValue({ result: { unserializableValue: 'NaN' } }, 'x')).toBeNaN()
  })
  it('throws on exception details', () => {
    expect(() =>
      runtimeValue({ result: {}, exceptionDetails: { text: 'boom', lineNumber: 1, columnNumber: 2 } }, 'x'),
    ).toThrow(/JavaScript evaluation failed at line 1, column 2/)
  })
})

describe('internal: jsLiteral / isInternalUrl', () => {
  it('escapes for JS', () => {
    expect(jsLiteral('a"b')).toBe('"a\\"b"')
  })
  it('detects internal URL prefixes', () => {
    expect(isInternalUrl('chrome://flags')).toBe(true)
    expect(isInternalUrl('about:blank')).toBe(true)
    expect(isInternalUrl('https://example.com')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Helpers wired through the mock CDP — verify CDP method shape.
// ---------------------------------------------------------------------------

describe('helpers: exported shapes', () => {
  const fns: Array<[string, unknown]> = [
    ['attach', attach],
    ['detach', detach],
    ['goto_url', goto_url],
    ['page_info', page_info],
    ['click_at_xy', click_at_xy],
    ['type_text', type_text],
    ['fill_input', fill_input],
    ['press_key', press_key],
    ['scroll', scroll],
    ['capture_screenshot', capture_screenshot],
    ['list_tabs', list_tabs],
    ['current_tab', current_tab],
    ['switch_tab', switch_tab],
    ['new_tab', new_tab],
    ['ensure_real_tab', ensure_real_tab],
    ['iframe_target', iframe_target],
    ['wait', wait],
    ['wait_for_load', wait_for_load],
    ['wait_for_element', wait_for_element],
    ['wait_for_network_idle', wait_for_network_idle],
    ['js', js],
    ['dispatch_key', dispatch_key],
    ['upload_file', upload_file],
    ['http_get', http_get],
  ]
  for (const [name, fn] of fns) {
    it(`exports ${name} as a function`, () => {
      expect(typeof fn).toBe('function')
    })
  }
})

describe('helpers: goto_url', () => {
  it('calls Page.navigate with the URL', async () => {
    const { session, calls } = mockSession(() => ({}))
    await goto_url(session, 'https://example.com')
    expect(calls).toEqual([
      { method: 'Page.navigate', params: { url: 'https://example.com' }, sessionId: 'SES' },
    ])
  })
})

describe('helpers: click_at_xy', () => {
  it('dispatches mousePressed then mouseReleased', async () => {
    const { session, calls } = mockSession(() => ({}))
    await click_at_xy(session, 10, 20)
    expect(calls.map((c) => c.params.type)).toEqual(['mousePressed', 'mouseReleased'])
    expect(calls.every((c) => c.params.x === 10 && c.params.y === 20)).toBe(true)
  })
})

describe('helpers: type_text', () => {
  it('uses Input.insertText', async () => {
    const { session, calls } = mockSession(() => ({}))
    await type_text(session, 'hi')
    expect(calls).toEqual([
      { method: 'Input.insertText', params: { text: 'hi' }, sessionId: 'SES' },
    ])
  })
})

describe('helpers: press_key', () => {
  it('emits keyDown -> char -> keyUp for printable keys', async () => {
    const { session, calls } = mockSession(() => ({}))
    await press_key(session, 'a')
    expect(calls.map((c) => c.params.type)).toEqual(['keyDown', 'char', 'keyUp'])
  })
  it('emits keyDown -> keyUp for Enter (text \\r still gets a char)', async () => {
    const { session, calls } = mockSession(() => ({}))
    await press_key(session, 'Enter')
    // Enter has text="\r" of length 1, so a `char` event is also emitted —
    // matches helpers.py:260–261 exactly.
    expect(calls.map((c) => c.params.type)).toEqual(['keyDown', 'char', 'keyUp'])
    expect(calls[0]!.params.windowsVirtualKeyCode).toBe(13)
  })
  it('emits keyDown -> keyUp (no char) for keys without text like Backspace', async () => {
    const { session, calls } = mockSession(() => ({}))
    await press_key(session, 'Backspace')
    expect(calls.map((c) => c.params.type)).toEqual(['keyDown', 'keyUp'])
  })
})

describe('helpers: scroll', () => {
  it('dispatches mouseWheel', async () => {
    const { session, calls } = mockSession(() => ({}))
    await scroll(session, 50, 60, -100, 5)
    expect(calls[0]!.params).toMatchObject({
      type: 'mouseWheel',
      x: 50,
      y: 60,
      deltaX: 5,
      deltaY: -100,
    })
  })
})

describe('helpers: page_info', () => {
  it('returns dialog when one is pending', async () => {
    const { session } = mockSession(() => ({}))
    session.pendingDialog = { type: 'alert', message: 'hi' }
    const info = await page_info(session)
    expect(info).toEqual({ dialog: { type: 'alert', message: 'hi' } })
  })
  it('parses JSON.stringify output from Runtime.evaluate', async () => {
    const payload = {
      url: 'https://example.com',
      title: 'X',
      w: 800,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 1200,
      ph: 900,
    }
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify(payload) } }
      }
      return {}
    })
    const info = await page_info(session)
    expect(info).toEqual(payload)
  })
})

describe('helpers: list_tabs', () => {
  it('filters non-page targets and respects includeChrome', async () => {
    const targets = [
      { targetId: 'A', type: 'page', title: 'A', url: 'https://a' },
      { targetId: 'B', type: 'page', title: 'B', url: 'chrome://flags' },
      { targetId: 'C', type: 'iframe', title: 'C', url: 'https://c' },
    ]
    const { session } = mockSession(() => ({ targetInfos: targets }))
    expect(await list_tabs(session, true)).toHaveLength(2)
    expect(await list_tabs(session, false)).toEqual([
      { targetId: 'A', title: 'A', url: 'https://a' },
    ])
  })
})

describe('helpers: iframe_target', () => {
  it('returns first matching iframe target id', async () => {
    const { session } = mockSession(() => ({
      targetInfos: [
        { targetId: 'A', type: 'page', url: 'https://a' },
        { targetId: 'B', type: 'iframe', url: 'https://embed.foo' },
      ],
    }))
    expect(await iframe_target(session, 'foo')).toBe('B')
    expect(await iframe_target(session, 'nope')).toBe(null)
  })
})

describe('helpers: js', () => {
  it('wraps top-level return in IIFE', async () => {
    const calls: string[] = []
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') {
        calls.push(String(c.params.expression))
        return { result: { value: 1 } }
      }
      return {}
    })
    await js(session, 'const x = 1; return x')
    expect(calls[0]!).toMatch(/^\(function\(\){const x = 1; return x}\)\(\)$/)
  })
  it('does not wrap a plain expression', async () => {
    const calls: string[] = []
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') {
        calls.push(String(c.params.expression))
        return { result: { value: 'X' } }
      }
      return {}
    })
    await js(session, 'document.title')
    expect(calls[0]).toBe('document.title')
  })
})

describe('helpers: capture_screenshot', () => {
  it('returns base64 from Page.captureScreenshot', async () => {
    const { session } = mockSession((c) => {
      if (c.method === 'Page.captureScreenshot') return { data: 'AAAA' }
      return {}
    })
    const r = await capture_screenshot(session)
    expect(r).toEqual({ base64: 'AAAA', format: 'png' })
  })
})

describe('helpers: http_get', () => {
  it('uses global fetch', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'hello',
    })) as unknown as typeof fetch
    try {
      const r = await http_get('https://example.com')
      expect(r.status).toBe(200)
      expect(r.body).toBe('hello')
      expect(r.headers['content-type']).toBe('text/plain')
    } finally {
      globalThis.fetch = orig
    }
  })
})

describe('internal: cdp routing', () => {
  it('omits sessionId for Target.* calls', async () => {
    const { session, calls } = mockSession(() => ({}))
    await cdp(session, 'Target.getTargets')
    expect(calls[0]!.sessionId).toBeUndefined()
  })
  it('attaches default session for non-Target calls', async () => {
    const { session, calls } = mockSession(() => ({}))
    await cdp(session, 'Page.reload')
    expect(calls[0]!.sessionId).toBe('SES')
  })
})

describe('helpers: switch_tab + ensure_real_tab', () => {
  it('switch_tab activates and re-attaches', async () => {
    const seen: string[] = []
    const { session } = mockSession((c) => {
      seen.push(c.method)
      return {}
    })
    const sid = await switch_tab(session, 'NEW')
    expect(sid).toBe('SES2')
    expect(seen).toContain('Target.activateTarget')
  })
  it('ensure_real_tab returns null when no tabs', async () => {
    const { session } = mockSession((c) => {
      if (c.method === 'Target.getTargets') return { targetInfos: [] }
      return {}
    })
    expect(await ensure_real_tab(session)).toBe(null)
  })
})

describe('helpers: new_tab', () => {
  it('creates about:blank, attaches, then navigates if URL given', async () => {
    const seen: string[] = []
    const { session } = mockSession((c) => {
      seen.push(c.method)
      if (c.method === 'Target.createTarget') return { targetId: 'NEWTAB' }
      if (c.method === 'Target.attachToTarget') return { sessionId: 'SES2' }
      return {}
    })
    const tid = await new_tab(session, 'https://example.com')
    expect(tid).toBe('NEWTAB')
    expect(seen).toContain('Target.createTarget')
    expect(seen).toContain('Page.navigate')
  })
})

describe('helpers: dispatch_key', () => {
  it('runs JS dispatching a KeyboardEvent', async () => {
    const exprs: string[] = []
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') {
        exprs.push(String(c.params.expression))
        return { result: { value: undefined } }
      }
      return {}
    })
    await dispatch_key(session, 'input', 'Enter')
    expect(exprs[0]!).toMatch(/dispatchEvent/)
    expect(exprs[0]!).toMatch(/keyCode:13/)
  })
})

describe('helpers: upload_file', () => {
  it('chains DOM.getDocument -> querySelector -> setFileInputFiles', async () => {
    const seen: string[] = []
    const { session } = mockSession((c) => {
      seen.push(c.method)
      if (c.method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (c.method === 'DOM.querySelector') return { nodeId: 99 }
      return {}
    })
    await upload_file(session, 'input[type=file]', '/tmp/x.txt')
    expect(seen).toEqual(['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles'])
  })
  it('throws when nodeId is 0', async () => {
    const { session } = mockSession((c) => {
      if (c.method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (c.method === 'DOM.querySelector') return { nodeId: 0 }
      return {}
    })
    await expect(upload_file(session, 'input', '/tmp/x')).rejects.toThrow(/no element/)
  })
})

describe('helpers: fill_input + wait_for_element', () => {
  it('fill_input throws when element not found', async () => {
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') return { result: { value: false } }
      return {}
    })
    await expect(fill_input(session, '#nope', 'hi')).rejects.toThrow(/element not found/)
  })

  it('wait_for_element returns true once querySelector matches', async () => {
    let calls = 0
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') {
        calls += 1
        return { result: { value: calls >= 2 } }
      }
      return {}
    })
    const r = await wait_for_element(session, '.foo', 1.0)
    expect(r).toBe(true)
  })
})

describe('helpers: wait_for_load', () => {
  it('returns true when readyState becomes complete', async () => {
    const { session } = mockSession((c) => {
      if (c.method === 'Runtime.evaluate') return { result: { value: 'complete' } }
      return {}
    })
    expect(await wait_for_load(session, 1.0)).toBe(true)
  })
})

describe('helpers: wait_for_network_idle', () => {
  it('returns true with no events', async () => {
    const { session } = mockSession(() => ({}))
    expect(await wait_for_network_idle(session, 1.0, 100)).toBe(true)
  })
})

describe('helpers: current_tab', () => {
  it('reads Target.getTargetInfo for current targetId', async () => {
    const { session } = mockSession((c) => {
      if (c.method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'TGT', url: 'https://x', title: 'T' } }
      }
      return {}
    })
    expect(await current_tab(session)).toEqual({ targetId: 'TGT', url: 'https://x', title: 'T' })
  })
})

describe('helpers: wait', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now()
    await wait(0.05)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

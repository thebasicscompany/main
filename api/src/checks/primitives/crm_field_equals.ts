/**
 * `crm_field_equals` — browser-based field assertion.
 *
 * Opens a fresh tab inside the agent's already-attached Browserbase
 * session, navigates to the target URL, waits for the selector, reads
 * its value, and compares against `expected`. Auth comes from the
 * Phase 07 cookie sync (Browserbase Contexts) — no API tokens required.
 *
 * Failure modes (each returns a structured `passed: false` evidence row,
 * never throws):
 *  - `no_session`        — `ctx.session` was not provided.
 *  - `navigation_failed` — `goto_url` / `wait_for_load` errored or timed out.
 *  - `selector_not_found`— element didn't appear within `timeoutMs`.
 *  - `value_mismatch`    — element exists but value !== expected (or no regex match).
 *  - `read_error`        — JS evaluation threw inside the page.
 *
 * Reads value as: `innerText` if non-empty, else the element's `value`
 * attribute (covers `<input>` / `<textarea>` / Salesforce Lightning text
 * outputs that often expose `aria-label` / `value` instead of innerText).
 */

import {
  js,
  new_tab,
  wait_for_element,
  wait_for_load,
} from '@basics/harness'
import type { CheckContext, CheckFn, CheckResult } from '../types.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface CrmFieldEqualsParams {
  /** Absolute URL to navigate to (must be reachable inside Browserbase). */
  url: string
  /** CSS selector for the field whose value should be compared. */
  selector: string
  /** Either a literal string for strict equality, or `{ regex: '...' }`. */
  expected: string | { regex: string }
  /** Override the default 30s timeout (covers nav + selector wait). */
  timeoutMs?: number
}

function compare(
  actual: string,
  expected: string | { regex: string },
): boolean {
  if (typeof expected === 'string') {
    return actual === expected
  }
  try {
    const re = new RegExp(expected.regex)
    return re.test(actual)
  } catch {
    return false
  }
}

export function crm_field_equals(params: CrmFieldEqualsParams): CheckFn {
  return async (ctx: CheckContext): Promise<CheckResult> => {
    const startedAt = Date.now()
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const expectedForEvidence =
      typeof params.expected === 'string'
        ? params.expected
        : { regex: params.expected.regex }

    if (!ctx.session) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expected: expectedForEvidence,
          reason: 'no_session',
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    const session = ctx.session

    // -- Step 1: open a fresh tab + navigate ---------------------------------
    try {
      await new_tab(session, params.url)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expected: expectedForEvidence,
          reason: 'navigation_failed',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // wait_for_load returns boolean — false on timeout. Don't fail the
    // whole check on a slow load (some SPAs never reach readyState=
    // complete) — just record it in evidence and try the selector wait.
    let loaded = false
    try {
      loaded = await wait_for_load(session, timeoutMs / 1000)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expected: expectedForEvidence,
          reason: 'navigation_failed',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // -- Step 2: wait for selector -------------------------------------------
    let found = false
    try {
      found = await wait_for_element(
        session,
        params.selector,
        timeoutMs / 1000,
      )
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expected: expectedForEvidence,
          loaded,
          reason: 'selector_not_found',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }
    if (!found) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expected: expectedForEvidence,
          loaded,
          reason: 'selector_not_found',
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // -- Step 3: read value --------------------------------------------------
    let actual: string
    try {
      // Prefer innerText (covers visible text on most CRM pages); fall
      // back to the `value` attribute for inputs/textareas. The
      // expression is a single IIFE so we round-trip a single string.
      const expr =
        '(() => {' +
        '  const sel = ' +
        JSON.stringify(params.selector) +
        ';' +
        '  const el = document.querySelector(sel);' +
        '  if (!el) return null;' +
        '  const text = (el.innerText || "").trim();' +
        '  if (text) return text;' +
        '  const val = el.getAttribute("value") || (el.value != null ? String(el.value) : "");' +
        '  return (val || "").trim();' +
        '})()'
      const raw = await js(session, expr)
      if (raw == null) {
        return {
          passed: false,
          evidence: {
            url: params.url,
            selector: params.selector,
            expected: expectedForEvidence,
            reason: 'selector_not_found',
            timing_ms: Date.now() - startedAt,
          },
        }
      }
      actual = String(raw)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expected: expectedForEvidence,
          reason: 'read_error',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // -- Step 4: compare -----------------------------------------------------
    const matched = compare(actual, params.expected)
    return {
      passed: matched,
      evidence: {
        url: params.url,
        selector: params.selector,
        actual,
        expected: expectedForEvidence,
        matched,
        ...(matched ? {} : { reason: 'value_mismatch' }),
        timing_ms: Date.now() - startedAt,
      },
    }
  }
}

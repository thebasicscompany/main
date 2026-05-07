/**
 * `record_count_changed` — browser-based count delta assertion.
 *
 * Navigates to a CRM/dashboard page in the agent's existing Browserbase
 * session, parses an integer out of a chosen DOM element, and compares
 * to the previous run's recorded count. Pure DOM read; no API tokens.
 *
 * Baseline lookup: query `runtime_check_results` for the most recent
 * `passed=true` row with `check_name='record_count_changed'`,
 * scoped to `(workspace_id, workflow_id)`. If no baseline is found,
 * the first run establishes one (passes with `baseline_established`).
 *
 * `expectChange`:
 *  - `'increase'` (default `undefined` → 'any'): pass iff `current - baseline >= minDelta` (default 1).
 *  - `'decrease'`: pass iff `baseline - current >= minDelta`.
 *  - `'any'`: pass iff `Math.abs(delta) >= minDelta`.
 *
 * Failure modes are structured (no throws):
 *  - `no_session`        — `ctx.session` was not provided.
 *  - `navigation_failed` — `goto_url` / `wait_for_load` errored or timed out.
 *  - `selector_not_found`— element didn't appear within `timeoutMs`.
 *  - `parse_failed`      — element text didn't yield a parseable integer.
 *  - `count_unchanged`   — value didn't satisfy `expectChange`/`minDelta`.
 */

import {
  js,
  new_tab,
  wait_for_element,
  wait_for_load,
} from '@basics/harness'
import { listForRun } from '../../orchestrator/checkResultsRepo.js'
import {
  list as listRuns,
  type RunRecord,
} from '../../orchestrator/runState.js'
import type { CheckContext, CheckFn, CheckResult } from '../types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const CHECK_NAME = 'record_count_changed'

export interface RecordCountChangedParams {
  url: string
  selector: string
  expectChange?: 'increase' | 'decrease' | 'any'
  minDelta?: number
  timeoutMs?: number
}

/**
 * Look up the most recent `passed=true` `record_count_changed` evidence
 * for `(workspaceId, workflowId)` and pull `evidence.count` off it.
 *
 * Implementation: page through completed runs for the workspace+workflow
 * (newest first) and inspect their check rows. The runs list typically
 * has only a handful of rows per workflow, so this stays cheap.
 */
async function lookupBaseline(
  workspaceId: string,
  workflowId: string,
  currentRunId: string,
): Promise<{ count: number; runId: string } | null> {
  let runs: RunRecord[]
  try {
    runs = await listRuns({ workspaceId, limit: 50 })
  } catch {
    return null
  }
  for (const run of runs) {
    if (run.runId === currentRunId) continue
    if (run.workflowId !== workflowId) continue
    let rows
    try {
      rows = await listForRun(run.runId)
    } catch {
      continue
    }
    for (const r of rows) {
      if (r.checkName !== CHECK_NAME) continue
      if (!r.passed) continue
      const ev = r.evidence
      if (
        ev &&
        typeof ev === 'object' &&
        !Array.isArray(ev) &&
        typeof (ev as Record<string, unknown>).count === 'number'
      ) {
        return {
          count: (ev as { count: number }).count,
          runId: run.runId,
        }
      }
    }
  }
  return null
}

function parseCount(text: string): number | null {
  const m = text.match(/-?\d[\d,]*/)
  if (!m) return null
  const stripped = m[0].replace(/,/g, '')
  const n = Number.parseInt(stripped, 10)
  return Number.isFinite(n) ? n : null
}

function evaluateChange(
  current: number,
  baseline: number,
  expectChange: 'increase' | 'decrease' | 'any',
  minDelta: number,
): boolean {
  const delta = current - baseline
  if (expectChange === 'increase') return delta >= minDelta
  if (expectChange === 'decrease') return -delta >= minDelta
  return Math.abs(delta) >= minDelta
}

export function record_count_changed(
  params: RecordCountChangedParams,
): CheckFn {
  return async (ctx: CheckContext): Promise<CheckResult> => {
    const startedAt = Date.now()
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const expectChange = params.expectChange ?? 'any'
    const minDelta = params.minDelta ?? 1

    if (!ctx.session) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expect_change: expectChange,
          reason: 'no_session',
          timing_ms: Date.now() - startedAt,
        },
      }
    }
    const session = ctx.session

    // -- Step 1: navigate ----------------------------------------------------
    try {
      await new_tab(session, params.url)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expect_change: expectChange,
          reason: 'navigation_failed',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }
    let loaded = false
    try {
      loaded = await wait_for_load(session, timeoutMs / 1000)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expect_change: expectChange,
          reason: 'navigation_failed',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // -- Step 2: wait for selector + read text -------------------------------
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
          expect_change: expectChange,
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
          expect_change: expectChange,
          loaded,
          reason: 'selector_not_found',
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    let text: string
    try {
      const expr =
        '(() => {' +
        '  const sel = ' +
        JSON.stringify(params.selector) +
        ';' +
        '  const el = document.querySelector(sel);' +
        '  if (!el) return null;' +
        '  return (el.innerText || el.textContent || "").trim();' +
        '})()'
      const raw = await js(session, expr)
      if (raw == null) {
        return {
          passed: false,
          evidence: {
            url: params.url,
            selector: params.selector,
            expect_change: expectChange,
            reason: 'selector_not_found',
            timing_ms: Date.now() - startedAt,
          },
        }
      }
      text = String(raw)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expect_change: expectChange,
          reason: 'read_error',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    const current = parseCount(text)
    if (current === null) {
      return {
        passed: false,
        evidence: {
          url: params.url,
          selector: params.selector,
          expect_change: expectChange,
          reason: 'parse_failed',
          text_excerpt: text.slice(0, 256),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // -- Step 3: baseline lookup ---------------------------------------------
    let baseline: { count: number; runId: string } | null = null
    if (ctx.workflowId) {
      baseline = await lookupBaseline(
        ctx.workspaceId,
        ctx.workflowId,
        ctx.runId,
      )
    }

    if (!baseline) {
      // First run: establish baseline. Pass so the run is verified, and
      // record `count` on evidence so the next run can read it back.
      return {
        passed: true,
        evidence: {
          url: params.url,
          selector: params.selector,
          count: current,
          baseline: null,
          delta: null,
          expect_change: expectChange,
          baseline_established: true,
          matched: true,
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    const delta = current - baseline.count
    const matched = evaluateChange(
      current,
      baseline.count,
      expectChange,
      minDelta,
    )
    return {
      passed: matched,
      evidence: {
        url: params.url,
        selector: params.selector,
        count: current,
        baseline: baseline.count,
        baseline_run_id: baseline.runId,
        delta,
        expect_change: expectChange,
        min_delta: minDelta,
        matched,
        ...(matched ? {} : { reason: 'count_unchanged' }),
        timing_ms: Date.now() - startedAt,
      },
    }
  }
}

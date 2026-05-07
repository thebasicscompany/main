/**
 * Check module registry — Phase 10 / 11.
 *
 * Maps the `check_modules` array on a `runtime_workflows` row into bound
 * `ScheduledCheck`s the runner can invoke. Each entry on the row carries
 * its own `params`; the registry routes (name -> builder) and the
 * builder calls into the matching primitive's factory.
 *
 * v1 entries:
 *   `url_contains`            → primitives/url_contains (real impl, fetch-based)
 *   `crm_field_equals`        → primitives/crm_field_equals (real, browser-based)
 *   `record_count_changed`    → primitives/record_count_changed (real, browser-based)
 *   `slack_message_posted`    → primitives/slack_message_posted (real, browser-based)
 *
 * Browser-based primitives reuse the agent's already-attached CDP session
 * via `CheckContext.session` — no fresh Browserbase boot. Auth is the
 * user's Phase 07 cookie sync surfacing inside the same Chrome instance.
 */

import type { ScheduledCheck } from './types.js'
import { url_contains } from './primitives/url_contains.js'
import { crm_field_equals } from './primitives/crm_field_equals.js'
import { record_count_changed } from './primitives/record_count_changed.js'
import { slack_message_posted } from './primitives/slack_message_posted.js'

export interface CheckModuleSpec {
  /** Registry key, e.g. `'url_contains'`. */
  name: string
  /**
   * Per-check params. Phase 11 lifted these onto the workflow row so
   * each entry carries its own configuration; callers always pass the
   * row's params verbatim.
   */
  params?: Record<string, unknown>
}

type CheckBuilder = (
  params: Record<string, unknown>,
) => ScheduledCheck | null

/**
 * Each builder returns a `ScheduledCheck` (the runner-facing shape) or
 * `null` when the supplied params are insufficient. A `null` return is
 * recorded as a failed check at the runner with a `missing_params` reason
 * — see `buildScheduledChecks` below.
 */
const REGISTRY: Record<string, CheckBuilder> = {
  url_contains(params) {
    const url = typeof params.url === 'string' ? params.url : null
    const contains =
      typeof params.contains === 'string' ? params.contains : null
    if (!url || !contains) return null
    const timeoutMs =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
    return {
      name: 'url_contains',
      fn: url_contains({
        url,
        contains,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    }
  },
  crm_field_equals(params) {
    const url = typeof params.url === 'string' ? params.url : null
    const selector =
      typeof params.selector === 'string' ? params.selector : null
    const expectedRaw = params.expected
    if (!url || !selector || expectedRaw === undefined) return null
    let expected: string | { regex: string }
    if (typeof expectedRaw === 'string') {
      expected = expectedRaw
    } else if (
      expectedRaw &&
      typeof expectedRaw === 'object' &&
      !Array.isArray(expectedRaw) &&
      typeof (expectedRaw as Record<string, unknown>).regex === 'string'
    ) {
      expected = { regex: (expectedRaw as { regex: string }).regex }
    } else {
      return null
    }
    const timeoutMs =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
    return {
      name: 'crm_field_equals',
      fn: crm_field_equals({
        url,
        selector,
        expected,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    }
  },
  record_count_changed(params) {
    const url = typeof params.url === 'string' ? params.url : null
    const selector =
      typeof params.selector === 'string' ? params.selector : null
    if (!url || !selector) return null
    const expectChange =
      params.expectChange === 'increase' ||
      params.expectChange === 'decrease' ||
      params.expectChange === 'any'
        ? params.expectChange
        : undefined
    const minDelta =
      typeof params.minDelta === 'number' ? params.minDelta : undefined
    const timeoutMs =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
    return {
      name: 'record_count_changed',
      fn: record_count_changed({
        url,
        selector,
        ...(expectChange !== undefined ? { expectChange } : {}),
        ...(minDelta !== undefined ? { minDelta } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    }
  },
  slack_message_posted(params) {
    const channel = typeof params.channel === 'string' ? params.channel : null
    if (!channel) return null
    const contains =
      typeof params.contains === 'string' ? params.contains : undefined
    const timeoutMs =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
    return {
      name: 'slack_message_posted',
      fn: slack_message_posted({
        channel,
        ...(contains !== undefined ? { contains } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    }
  },
}

/**
 * Resolve check module specs to runner-ready `ScheduledCheck`s.
 *
 * Unknown names and primitives that need params they didn't get produce
 * a synthetic `ScheduledCheck` whose `fn` returns a failed result with a
 * structured `evidence.reason` — that way the run still surfaces the
 * misconfiguration in audit instead of silently dropping checks.
 */
export function buildScheduledChecks(
  specs: CheckModuleSpec[],
): ScheduledCheck[] {
  const out: ScheduledCheck[] = []
  for (const spec of specs) {
    const builder = REGISTRY[spec.name]
    if (!builder) {
      out.push({
        name: spec.name,
        fn: async () => ({
          passed: false,
          evidence: {
            reason: 'unknown_check_module',
            check_module: spec.name,
          },
        }),
      })
      continue
    }
    const check = builder(spec.params ?? {})
    if (!check) {
      out.push({
        name: spec.name,
        fn: async () => ({
          passed: false,
          evidence: {
            reason: 'missing_params',
            check_module: spec.name,
            params: spec.params ?? {},
          },
        }),
      })
      continue
    }
    out.push(check)
  }
  return out
}

export function isRegisteredCheckModule(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name)
}

export function listRegisteredCheckModules(): string[] {
  return Object.keys(REGISTRY)
}

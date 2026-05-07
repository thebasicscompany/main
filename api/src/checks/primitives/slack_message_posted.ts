/**
 * `slack_message_posted` — browser-based Slack channel inspection.
 *
 * Navigates to `https://slack.com/archives/<channel>` inside the agent's
 * authenticated Browserbase session. Slack redirects to the user's
 * workspace and channel automatically when cookies are present (via
 * Phase 07 sync). If we land back on a login URL, the session was not
 * authenticated → structured failure.
 *
 * For substring assertions: read `document.body.innerText` and check
 * the substring exists. Slack's SPA renders messages into the DOM after
 * load, so we wait a bit for the message pane to settle before reading.
 *
 * Failure modes (each returns structured `passed: false`, never throws):
 *  - `no_session`            — `ctx.session` was not provided.
 *  - `navigation_failed`     — `goto_url` / `wait_for_load` errored.
 *  - `not_authenticated`     — final URL bounced to a Slack login screen.
 *  - `substring_not_found`   — `contains` was set but the body excerpt didn't include it.
 *  - `read_error`            — JS evaluation threw inside the page.
 */

import {
  js,
  new_tab,
  page_info,
  wait,
  wait_for_load,
} from '@basics/harness'
import type { CheckContext, CheckFn, CheckResult } from '../types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const POST_LOAD_SETTLE_MS = 5_000
const BODY_EXCERPT_BYTES = 1024

export interface SlackMessagePostedParams {
  /**
   * Slack channel id (`C0123ABC`) or name. The URL pattern
   * `slack.com/archives/<channel>` accepts either when authenticated.
   */
  channel: string
  /** Optional substring to assert is present in the rendered channel body. */
  contains?: string
  timeoutMs?: number
}

/**
 * Heuristic: a Slack URL is "authenticated" when it lives on the workspace
 * subdomain or the canonical `app.slack.com` path. Login bounces typically
 * land on `slack.com/signin`, `slack.com/?<...>`, or `slack.com/get-started`.
 */
function isAuthenticatedSlackUrl(url: string): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  if (!lower.includes('slack.com')) return false
  if (
    lower.includes('/signin') ||
    lower.includes('/get-started') ||
    lower.includes('/sso/') ||
    lower.includes('/checkcookie')
  ) {
    return false
  }
  return (
    lower.includes('/messages/') ||
    lower.includes('/client/') ||
    lower.includes('/archives/') ||
    /\bapp\.slack\.com\b/.test(lower)
  )
}

export function slack_message_posted(
  params: SlackMessagePostedParams,
): CheckFn {
  return async (ctx: CheckContext): Promise<CheckResult> => {
    const startedAt = Date.now()
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const targetUrl = `https://slack.com/archives/${encodeURIComponent(
      params.channel,
    )}`

    if (!ctx.session) {
      return {
        passed: false,
        evidence: {
          channel: params.channel,
          ...(params.contains !== undefined
            ? { contains: params.contains }
            : {}),
          reason: 'no_session',
          timing_ms: Date.now() - startedAt,
        },
      }
    }
    const session = ctx.session

    // -- Step 1: open new tab + navigate -------------------------------------
    try {
      await new_tab(session, targetUrl)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          channel: params.channel,
          ...(params.contains !== undefined
            ? { contains: params.contains }
            : {}),
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
          channel: params.channel,
          ...(params.contains !== undefined
            ? { contains: params.contains }
            : {}),
          reason: 'navigation_failed',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // Slack's SPA finishes navigation long before the message pane
    // hydrates. A brief settle window gives the body time to render.
    await wait(POST_LOAD_SETTLE_MS / 1000)

    // -- Step 2: capture final URL + auth detection --------------------------
    let finalUrl = ''
    try {
      const info = await page_info(session)
      // page_info returns either { dialog } or a plain PageInfo. The
      // dialog-only case shouldn't happen here but guard anyway.
      if ('url' in info && typeof info.url === 'string') {
        finalUrl = info.url
      }
    } catch {
      // Non-fatal — we'll fall through and try the body read; failure
      // there will surface as a structured `read_error`.
    }

    if (!isAuthenticatedSlackUrl(finalUrl)) {
      return {
        passed: false,
        evidence: {
          channel: params.channel,
          ...(params.contains !== undefined
            ? { contains: params.contains }
            : {}),
          final_url: finalUrl,
          loaded,
          reason: 'not_authenticated',
          matched: false,
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // -- Step 3: read body ----------------------------------------------------
    let body: string
    try {
      const raw = await js(session, 'document.body && document.body.innerText')
      body = raw == null ? '' : String(raw)
    } catch (err) {
      return {
        passed: false,
        evidence: {
          channel: params.channel,
          ...(params.contains !== undefined
            ? { contains: params.contains }
            : {}),
          final_url: finalUrl,
          reason: 'read_error',
          error: err instanceof Error ? err.message : String(err),
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    const bodyExcerpt = body.slice(0, BODY_EXCERPT_BYTES)

    // -- Step 4: optional substring check ------------------------------------
    if (params.contains !== undefined) {
      const matched = body.includes(params.contains)
      return {
        passed: matched,
        evidence: {
          channel: params.channel,
          contains: params.contains,
          final_url: finalUrl,
          matched,
          ...(matched ? {} : { reason: 'substring_not_found' }),
          body_excerpt: bodyExcerpt,
          body_length: body.length,
          timing_ms: Date.now() - startedAt,
        },
      }
    }

    // No substring requested — passing means "we reached the channel
    // page authenticated."
    return {
      passed: true,
      evidence: {
        channel: params.channel,
        final_url: finalUrl,
        matched: true,
        body_excerpt: bodyExcerpt,
        body_length: body.length,
        timing_ms: Date.now() - startedAt,
      },
    }
  }
}


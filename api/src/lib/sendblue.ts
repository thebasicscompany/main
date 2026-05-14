/**
 * Outbound Sendblue SMS helper. Wraps POST /api/send-message with the
 * api-side env credentials (SENDBLUE_API_KEY, SENDBLUE_API_SECRET,
 * SENDBLUE_FROM_NUMBER) and a fetch test seam.
 *
 * Used by:
 *   - api/src/routes/sendblue-inbound.ts (confirmation replies)
 *   - api/src/routes/approvals.ts (G.2 desktop-decision SMS cancel)
 *
 * Failure mode: returns `{ delivered: false, reason }` instead of
 * throwing — Sendblue outages must not block the approval decision
 * flow.
 */

import { logger } from '../middleware/logger.js'

const SENDBLUE_URL = 'https://api.sendblue.co/api/send-message'

/** Test seam — swap in a fake fetch for unit tests. */
let _fetchForTests: typeof fetch | null = null
export function setSendblueFetchForTests(fn: typeof fetch | null): void {
  _fetchForTests = fn
}

export interface SendblueSendInput {
  to: string
  content: string
  /** If omitted, falls back to SENDBLUE_FROM_NUMBER env. */
  fromNumber?: string
}

export interface SendblueSendResult {
  delivered: boolean
  reason?: string
  status?: number
}

export async function sendSendblueMessage(input: SendblueSendInput): Promise<SendblueSendResult> {
  const apiKey = process.env.SENDBLUE_API_KEY
  const apiSecret = process.env.SENDBLUE_API_SECRET
  const fromNumber = input.fromNumber ?? process.env.SENDBLUE_FROM_NUMBER
  if (!apiKey || !apiSecret || !fromNumber) {
    logger.warn(
      { hasApiKey: !!apiKey, hasApiSecret: !!apiSecret, hasFromNumber: !!fromNumber },
      'sendblue send skipped — env missing',
    )
    return { delivered: false, reason: 'env_missing' }
  }
  const fetchImpl = _fetchForTests ?? globalThis.fetch
  try {
    const res = await fetchImpl(SENDBLUE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'sb-api-key-id': apiKey,
        'sb-api-secret-key': apiSecret,
      },
      body: JSON.stringify({
        number: input.to,
        from_number: fromNumber,
        content: input.content,
      }),
    })
    if (!res.ok) {
      logger.warn({ status: res.status, to: input.to }, 'sendblue send non-2xx')
      return { delivered: false, reason: 'http_error', status: res.status }
    }
    // Sendblue can return 200 with error_message in the body (per
    // memory: project_sendblue_api_shape.md). Check it.
    let parsed: Record<string, unknown> = {}
    try {
      parsed = (await res.json()) as Record<string, unknown>
    } catch {
      /* tolerate empty body */
    }
    const errMsg = (parsed.error_message ?? parsed.errorMessage) as string | undefined
    if (typeof errMsg === 'string' && errMsg.length > 0) {
      logger.warn({ to: input.to, errMsg }, 'sendblue send body-level error_message')
      return { delivered: false, reason: 'api_error', status: res.status }
    }
    return { delivered: true, status: res.status }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'sendblue send threw')
    return { delivered: false, reason: 'exception' }
  }
}

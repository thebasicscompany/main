import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  getComposioApiKey as getSharedComposioApiKey,
  listComposioManagedSkills as listSharedComposioManagedSkills,
  markComposioConnectedAccountExpired,
  type ComposioClient as SharedComposioClient,
} from '@basics/shared'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'

const DEFAULT_TOLERANCE_SECONDS = 5 * 60

export {
  ComposioClient,
  ComposioUnavailableError,
  listExecutableComposioTools,
  normalizeComposioSkillPreferences,
  normalizeConnectLink,
  resetComposioConnectionStateForTests,
  type ComposioTool,
  type ExecutableComposioTool,
  type ComposioManagedSkill,
  type ComposioSkillPreferences,
} from '@basics/shared'

export const SUPPORTED_COMPOSIO_WEBHOOK_EVENTS = new Set([
  'composio.trigger.message',
  'composio.connected_account.expired',
  'composio.trigger.disabled',
])

export type ComposioWebhookVerificationResult =
  | { ok: true; payload: Record<string, unknown> }
  | {
      ok: false
      reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_signature' | 'invalid_json'
    }

export function getComposioApiKey(): string | undefined {
  return getSharedComposioApiKey(getConfig())
}

export function getComposioWebhookSecret(): string | undefined {
  const cfg = getConfig()
  return (
    cfg.COMPOSIO_WEBHOOK_SECRET?.trim() || cfg.BASICS_COMPOSIO_WEBHOOK_SECRET?.trim() || undefined
  )
}

export function listComposioManagedSkills(
  userId: string,
  client?: Pick<
    SharedComposioClient,
    'listToolkits' | 'listAuthConfigs' | 'listConnectedAccounts' | 'createConnectLink'
  > &
    Partial<Pick<SharedComposioClient, 'listTools'>>,
  preferences?: unknown,
  options?: { includeTools?: boolean },
) {
  return listSharedComposioManagedSkills(userId, client, logger, preferences, options)
}

function extractSignature(signatureHeader: string): string {
  const first = signatureHeader.split(' ')[0] ?? signatureHeader
  const [, value] = first.split(',', 2)
  return value ?? first
}

export function verifyComposioWebhookSignature(input: {
  headers: Headers
  rawBody: string
  secret: string
  nowSeconds?: number
  toleranceSeconds?: number
}): ComposioWebhookVerificationResult {
  const webhookId = input.headers.get('webhook-id')
  const timestamp = input.headers.get('webhook-timestamp')
  const signatureHeader = input.headers.get('webhook-signature')
  if (!webhookId || !timestamp || !signatureHeader || !input.secret) {
    return { ok: false, reason: 'missing_headers' }
  }

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: 'bad_timestamp' }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (tolerance > 0) {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (Math.abs(now - timestampSeconds) > tolerance) return { ok: false, reason: 'stale' }
  }

  const expected = createHmac('sha256', input.secret)
    .update(`${webhookId}.${timestamp}.${input.rawBody}`, 'utf8')
    .digest('base64')
  const received = extractSignature(signatureHeader)
  const expectedBuffer = Buffer.from(expected)
  const receivedBuffer = Buffer.from(received)
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return { ok: false, reason: 'bad_signature' }
  }

  try {
    const payload = JSON.parse(input.rawBody)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid_json' }
    }
    return { ok: true, payload: payload as Record<string, unknown> }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}

export async function handleComposioLifecycleEvent(payload: Record<string, unknown>): Promise<{
  ok: true
  ignored?: true
  routed?: { runId?: string; automationId?: string; triggerEventLogId?: string; reason?: string }
  connectionExpired?: { emitted: boolean; runId?: string }
}> {
  const type = typeof payload.type === 'string' ? payload.type : undefined
  if (!type || !SUPPORTED_COMPOSIO_WEBHOOK_EVENTS.has(type)) return { ok: true, ignored: true }

  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {}
  const connectedAccountId =
    typeof metadata.connected_account_id === 'string' ? metadata.connected_account_id : undefined

  // D.5 lazily import to avoid a circular module init issue at boot.
  const { routeTriggerMessage, emitConnectionExpiredEvent } =
    await import('./composio-trigger-router.js')

  if (type === 'composio.connected_account.expired' && connectedAccountId) {
    markComposioConnectedAccountExpired(connectedAccountId)
    logger.info({ connectedAccountId }, 'composio connected account expired')
    const emitted = await emitConnectionExpiredEvent(connectedAccountId).catch((e) => {
      logger.error({ err: (e as Error).message }, 'emitConnectionExpiredEvent failed')
      return { emitted: false } as const
    })
    return { ok: true, connectionExpired: emitted }
  }
  if (type === 'composio.trigger.disabled') {
    logger.warn({ connectedAccountId, eventId: payload.id }, 'composio trigger disabled')
    return { ok: true }
  }
  if (type === 'composio.trigger.message') {
    logger.info({ connectedAccountId, eventId: payload.id }, 'composio trigger message received')
    const routed = await routeTriggerMessage(payload).catch((e) => {
      logger.error({ err: (e as Error).message }, 'routeTriggerMessage failed')
      return { routed: false, reason: 'router_error' } as const
    })
    return { ok: true, routed }
  }

  return { ok: true }
}

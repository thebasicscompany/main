import { createHmac, timingSafeEqual } from 'node:crypto'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'

const DEFAULT_BASE_URL = 'https://backend.composio.dev/api/v3.1'
const DEFAULT_TOLERANCE_SECONDS = 5 * 60

export const SUPPORTED_COMPOSIO_WEBHOOK_EVENTS = new Set([
  'composio.trigger.message',
  'composio.connected_account.expired',
  'composio.trigger.disabled',
])

export class ComposioUnavailableError extends Error {
  constructor(message = 'Composio is not configured') {
    super(message)
    this.name = 'ComposioUnavailableError'
  }
}

interface ComposioToolkit {
  slug: string
  name?: string
  meta?: {
    description?: string
    logo?: string
  }
}

interface ComposioAuthConfig {
  id: string
  name?: string
  status?: string
  toolkit?: {
    slug?: string
    logo?: string
  }
}

interface ComposioConnectedAccount {
  id: string
  status?: string
  toolkit?: {
    slug?: string
  }
  auth_config?: {
    id?: string
  }
}

export interface ComposioConnectLink {
  redirect_url?: string
  connected_account_id?: string
  expires_at?: string
  [key: string]: unknown
}

export interface NormalizedComposioConnectLink {
  redirectUrl?: string
  connectedAccountId?: string
  expiresAt?: string
  raw: ComposioConnectLink
}

export interface ComposioTool {
  slug: string
  name?: string
  description?: string
  toolkit?: {
    slug?: string
  }
  [key: string]: unknown
}

export interface ComposioManagedSkill {
  id: string
  name: string
  description: string
  kind: 'catalog'
  status: 'enabled' | 'needs_configuration' | 'unavailable'
  origin: 'composio'
  source: 'composio'
  requiresLocalClient: false
  requiresConnection: true
  connectionStatus: string
  authConfigId?: string
  connectedAccountId?: string
  connectUrl?: string
  logoUrl?: string
  toolkitSlug: string
}

export type ComposioWebhookVerificationResult =
  | { ok: true; payload: Record<string, unknown> }
  | {
      ok: false
      reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_signature' | 'invalid_json'
    }

const expiredConnectedAccountIds = new Set<string>()

export function getComposioApiKey(): string | undefined {
  const cfg = getConfig()
  return cfg.COMPOSIO_API_KEY?.trim() || cfg.BASICS_COMPOSIO_API_KEY?.trim() || undefined
}

export function getComposioWebhookSecret(): string | undefined {
  const cfg = getConfig()
  return (
    cfg.COMPOSIO_WEBHOOK_SECRET?.trim() ||
    cfg.BASICS_COMPOSIO_WEBHOOK_SECRET?.trim() ||
    undefined
  )
}

function getComposioBaseUrl(): string {
  return (getConfig().COMPOSIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function normalizeItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { items?: unknown }).items)
  ) {
    return (payload as { items: T[] }).items
  }
  return []
}

export function normalizeConnectLink(raw: ComposioConnectLink): NormalizedComposioConnectLink {
  return {
    redirectUrl: raw.redirect_url,
    connectedAccountId: raw.connected_account_id,
    expiresAt: raw.expires_at,
    raw,
  }
}

export class ComposioClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    const apiKey = options?.apiKey ?? getComposioApiKey()
    if (!apiKey) throw new ComposioUnavailableError()
    this.apiKey = apiKey
    this.baseUrl = (options?.baseUrl ?? getComposioBaseUrl()).replace(/\/+$/, '')
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(
        `Composio ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      ) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    if (response.status === 204) return {}
    return response.json()
  }

  async listToolkits(): Promise<ComposioToolkit[]> {
    return normalizeItems<ComposioToolkit>(await this.request('/toolkits?limit=1000'))
  }

  async listTools(options?: {
    toolkitSlug?: string
    query?: string
    authConfigIds?: string
  }): Promise<ComposioTool[]> {
    const params = new URLSearchParams({ limit: '100' })
    if (options?.toolkitSlug) params.set('toolkit_slug', options.toolkitSlug)
    if (options?.query) params.set('query', options.query)
    if (options?.authConfigIds) params.set('auth_config_ids', options.authConfigIds)
    return normalizeItems<ComposioTool>(await this.request(`/tools?${params.toString()}`))
  }

  async listAuthConfigs(): Promise<ComposioAuthConfig[]> {
    return normalizeItems<ComposioAuthConfig>(
      await this.request('/auth_configs?limit=1000&show_disabled=true'),
    )
  }

  async listConnectedAccounts(userId: string): Promise<ComposioConnectedAccount[]> {
    const params = new URLSearchParams({ user_ids: userId, limit: '1000' })
    return normalizeItems<ComposioConnectedAccount>(
      await this.request(`/connected_accounts?${params.toString()}`),
    )
  }

  async createConnectLink(
    authConfigId: string,
    userId: string,
    options?: { callbackUrl?: string },
  ): Promise<ComposioConnectLink> {
    const body: Record<string, string> = {
      auth_config_id: authConfigId,
      user_id: userId,
    }
    if (options?.callbackUrl) body.callback_url = options.callbackUrl
    return (await this.request('/connected_accounts/link', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as ComposioConnectLink
  }

  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    await this.request(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`, {
      method: 'DELETE',
    })
  }

  async executeTool(
    toolSlug: string,
    input: {
      userId: string
      connectedAccountId?: string
      arguments?: Record<string, unknown>
      text?: string
    },
  ): Promise<unknown> {
    return this.request(`/tools/execute/${encodeURIComponent(toolSlug)}`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: input.userId,
        connected_account_id: input.connectedAccountId,
        arguments: input.arguments,
        text: input.text,
      }),
    })
  }
}

function accountStatus(account: ComposioConnectedAccount | undefined): {
  status: ComposioManagedSkill['status']
  connectionStatus: string
} {
  if (!account) return { status: 'needs_configuration', connectionStatus: 'not_connected' }
  if (expiredConnectedAccountIds.has(account.id)) {
    return { status: 'needs_configuration', connectionStatus: 'expired' }
  }
  const raw = account.status?.toUpperCase()
  if (!raw || raw === 'ACTIVE' || raw === 'ENABLED' || raw === 'CONNECTED') {
    return { status: 'enabled', connectionStatus: 'connected' }
  }
  return { status: 'needs_configuration', connectionStatus: raw.toLowerCase() }
}

export async function listComposioManagedSkills(
  userId: string,
  client: Pick<
    ComposioClient,
    'listToolkits' | 'listAuthConfigs' | 'listConnectedAccounts' | 'createConnectLink'
  > = new ComposioClient(),
): Promise<ComposioManagedSkill[]> {
  const [toolkits, authConfigs, connectedAccounts] = await Promise.all([
    client.listToolkits(),
    client.listAuthConfigs(),
    client.listConnectedAccounts(userId),
  ])

  const toolkitsBySlug = new Map(toolkits.map((toolkit) => [toolkit.slug, toolkit]))
  const accountsByAuthConfig = new Map<string, ComposioConnectedAccount>()
  for (const account of connectedAccounts) {
    const authConfigId = account.auth_config?.id
    if (authConfigId && !accountsByAuthConfig.has(authConfigId)) {
      accountsByAuthConfig.set(authConfigId, account)
    }
  }

  const skills: ComposioManagedSkill[] = []
  for (const authConfig of authConfigs) {
    const toolkitSlug = authConfig.toolkit?.slug
    if (!toolkitSlug || authConfig.status?.toUpperCase() === 'DISABLED') continue

    const toolkit = toolkitsBySlug.get(toolkitSlug)
    const account = accountsByAuthConfig.get(authConfig.id)
    const status = accountStatus(account)
    let connectUrl: string | undefined
    if (status.status === 'needs_configuration') {
      try {
        connectUrl = (await client.createConnectLink(authConfig.id, userId)).redirect_url
      } catch (err) {
        logger.warn({ err, authConfigId: authConfig.id, toolkitSlug }, 'composio connect link failed')
      }
    }

    skills.push({
      id: `composio-${toolkitSlug}`,
      name: toolkit?.name ?? authConfig.name ?? toolkitSlug,
      description:
        toolkit?.meta?.description ?? `Connect ${toolkit?.name ?? toolkitSlug} through Composio.`,
      logoUrl: toolkit?.meta?.logo ?? authConfig.toolkit?.logo,
      kind: 'catalog',
      origin: 'composio',
      status: status.status,
      source: 'composio',
      requiresLocalClient: false,
      requiresConnection: true,
      connectionStatus: status.connectionStatus,
      authConfigId: authConfig.id,
      connectedAccountId: account?.id,
      connectUrl,
      toolkitSlug,
    })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
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

export function handleComposioLifecycleEvent(payload: Record<string, unknown>): {
  ok: true
  ignored?: true
} {
  const type = typeof payload.type === 'string' ? payload.type : undefined
  if (!type || !SUPPORTED_COMPOSIO_WEBHOOK_EVENTS.has(type)) return { ok: true, ignored: true }

  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {}
  const connectedAccountId =
    typeof metadata.connected_account_id === 'string' ? metadata.connected_account_id : undefined

  if (type === 'composio.connected_account.expired' && connectedAccountId) {
    expiredConnectedAccountIds.add(connectedAccountId)
    logger.info({ connectedAccountId }, 'composio connected account expired')
  } else if (type === 'composio.trigger.disabled') {
    logger.warn({ connectedAccountId, eventId: payload.id }, 'composio trigger disabled')
  } else if (type === 'composio.trigger.message') {
    logger.info({ connectedAccountId, eventId: payload.id }, 'composio trigger message received')
  }

  return { ok: true }
}

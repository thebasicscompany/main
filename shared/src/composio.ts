const DEFAULT_BASE_URL = 'https://backend.composio.dev/api/v3.1'

export class ComposioUnavailableError extends Error {
  constructor(message = 'Composio is not configured') {
    super(message)
    this.name = 'ComposioUnavailableError'
  }
}

export interface ComposioToolkit {
  slug: string
  name?: string
  meta?: {
    description?: string
    logo?: string
  }
}

export interface ComposioAuthConfig {
  id: string
  name?: string
  status?: string
  toolkit?: {
    slug?: string
    logo?: string
  }
}

export interface ComposioConnectedAccount {
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
  auth_config?: {
    id?: string
  }
  input_schema?: unknown
  parameters?: unknown
  schema?: unknown
  [key: string]: unknown
}

export interface ComposioSkillToolMetadata {
  slug: string
  name?: string
  description?: string
  toolkitSlug?: string
  inputSchema?: unknown
  enabled: boolean
}

export interface ComposioSkillPreferences {
  disabledToolkitSlugs: string[]
  disabledToolSlugs: string[]
  connectedAccountIdsByToolkit: Record<string, string>
  display?: Record<string, unknown>
}

export interface ComposioManagedSkill {
  id: string
  name: string
  description: string
  kind: 'catalog' | 'installed'
  status: 'enabled' | 'disabled' | 'needs_configuration' | 'unavailable'
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
  removable?: boolean
  configurable?: boolean
  enabledToolCount?: number
  disabledToolCount?: number
  tools?: ComposioSkillToolMetadata[]
}

export interface ExecutableComposioTool {
  tool: ComposioTool
  authConfig: ComposioAuthConfig
  connectedAccount: ComposioConnectedAccount
}

export interface ComposioConfig {
  apiKey?: string
  baseUrl?: string
}

export interface ComposioLogger {
  warn: (payload: unknown, message: string) => void
}

type ComposioEnv = Record<string, unknown>

const EMPTY_COMPOSIO_SKILL_PREFERENCES: ComposioSkillPreferences = {
  disabledToolkitSlugs: [],
  disabledToolSlugs: [],
  connectedAccountIdsByToolkit: {},
}

const expiredConnectedAccountIds = new Set<string>()

function defaultEnv(): ComposioEnv {
  return (globalThis as unknown as { process?: { env?: ComposioEnv } }).process?.env ?? {}
}

export function getComposioApiKey(env: ComposioEnv = defaultEnv()): string | undefined {
  const composioApiKey = typeof env.COMPOSIO_API_KEY === 'string' ? env.COMPOSIO_API_KEY.trim() : ''
  const basicsComposioApiKey =
    typeof env.BASICS_COMPOSIO_API_KEY === 'string' ? env.BASICS_COMPOSIO_API_KEY.trim() : ''
  return composioApiKey || basicsComposioApiKey || undefined
}

export function getComposioBaseUrl(env: ComposioEnv = defaultEnv()): string {
  const baseUrl =
    typeof env.COMPOSIO_BASE_URL === 'string' ? env.COMPOSIO_BASE_URL : DEFAULT_BASE_URL
  return baseUrl.replace(/\/+$/, '')
}

export function normalizeItems<T>(payload: unknown): T[] {
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

export function buildComposioExecutePayload(input: {
  userId: string
  connectedAccountId?: string
  arguments?: Record<string, unknown>
  text?: string
}): Record<string, unknown> {
  return {
    user_id: input.userId,
    connected_account_id: input.connectedAccountId,
    arguments: input.arguments,
    text: input.text,
  }
}

export class ComposioClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(options?: ComposioConfig) {
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
      body: JSON.stringify(buildComposioExecutePayload(input)),
    })
  }

  /**
   * D.4 — Subscribe to a Composio trigger instance.
   *
   * Composio's trigger API lives at `/api/v3` (NOT the v3.1 base used
   * elsewhere by ComposioClient). The path is `POST /api/v3/
   * trigger_instances/{slug}/upsert` where `{slug}` is the trigger type
   * slug (e.g. `GMAIL_NEW_GMAIL_MESSAGE`). Body: `{ connected_account_id,
   * trigger_config? }`. Response: `{ trigger_id, deprecated:{uuid} }`.
   *
   * The plan §5.3.3 schema is `createTrigger({ toolkit, event_type,
   * callback_url, filters })` — we drop `callback_url` since Composio
   * resolves it from the workspace's webhook configuration, and we
   * pass `event_type` as the URL slug.
   */
  async createTrigger(input: {
    toolkit: string // unused by the upsert call (slug is the source of truth)
    eventType: string
    callbackUrl: string // unused — Composio reads webhook from dashboard config
    connectedAccountId: string
    filters?: Record<string, unknown>
  }): Promise<{ triggerId: string; raw: unknown }> {
    const body: Record<string, unknown> = {
      connected_account_id: input.connectedAccountId,
    }
    if (input.filters && Object.keys(input.filters).length > 0) {
      body.trigger_config = input.filters
    }
    // Use the v3 namespace directly. Build the URL by replacing the v3.1
    // segment in our base URL with v3.
    const v3Base = this.baseUrl.replace(/\/v3\.1$/, '/v3')
    const path = `/trigger_instances/${encodeURIComponent(input.eventType)}/upsert`
    const response = await fetch(`${v3Base}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Composio POST ${path} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      )
    }
    const raw = (await response.json()) as { trigger_id?: string } & Record<string, unknown>
    const triggerId = raw.trigger_id
    if (!triggerId) {
      throw new Error(
        `Composio upsert returned no trigger_id; raw=${JSON.stringify(raw).slice(0, 300)}`,
      )
    }
    return { triggerId, raw }
  }

  /**
   * F.9 — Look up a trigger type's delivery mechanism.
   *
   * GET /api/v3/triggers_types/{slug} returns the trigger's metadata
   * including a `type` field that is either 'webhook' (Composio
   * pushes to our /webhooks/composio endpoint via Standard Webhooks)
   * or 'poll' (Composio's managed-auth polling worker walks the
   * resource on a 15-min cadence).
   *
   * The trigger-registry uses this to decide whether to register
   * with Composio's createTrigger (webhook) or insert into our own
   * composio_poll_state (poll, when we have a self-hosted adapter).
   */
  async getTriggerType(slug: string): Promise<{ type: 'webhook' | 'poll' | string; raw: unknown }> {
    const v3Base = this.baseUrl.replace(/\/v3\.1$/, '/v3')
    const path = `/triggers_types/${encodeURIComponent(slug)}`
    const response = await fetch(`${v3Base}${path}`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
      },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Composio GET ${path} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      )
    }
    const raw = (await response.json()) as { type?: string } & Record<string, unknown>
    const type = typeof raw.type === 'string' ? raw.type : 'webhook'
    return { type, raw }
  }

  /** DELETE /api/v3/trigger_instances/manage/{triggerId}. */
  async deleteTrigger(triggerId: string): Promise<void> {
    const v3Base = this.baseUrl.replace(/\/v3\.1$/, '/v3')
    const path = `/trigger_instances/manage/${encodeURIComponent(triggerId)}`
    const response = await fetch(`${v3Base}${path}`, {
      method: 'DELETE',
      headers: { 'x-api-key': this.apiKey },
    })
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Composio DELETE ${path} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      )
    }
  }
}

export function markComposioConnectedAccountExpired(connectedAccountId: string): void {
  expiredConnectedAccountIds.add(connectedAccountId)
}

export function resetComposioConnectionStateForTests(): void {
  expiredConnectedAccountIds.clear()
}

export function isComposioAuthConfigEnabled(authConfig: ComposioAuthConfig): boolean {
  return authConfig.status?.toUpperCase() !== 'DISABLED'
}

export function isComposioConnectedAccountActive(
  account: ComposioConnectedAccount | undefined,
): boolean {
  if (!account) return false
  if (expiredConnectedAccountIds.has(account.id)) return false
  const raw = account.status?.toUpperCase()
  return !raw || raw === 'ACTIVE' || raw === 'ENABLED' || raw === 'CONNECTED'
}

function accountStatus(account: ComposioConnectedAccount | undefined): {
  status: ComposioManagedSkill['status']
  connectionStatus: string
} {
  if (!account) return { status: 'needs_configuration', connectionStatus: 'not_connected' }
  if (expiredConnectedAccountIds.has(account.id)) {
    return { status: 'needs_configuration', connectionStatus: 'expired' }
  }
  if (isComposioConnectedAccountActive(account)) {
    return { status: 'enabled', connectionStatus: 'connected' }
  }
  return {
    status: 'needs_configuration',
    connectionStatus: account.status?.toLowerCase() ?? 'unknown',
  }
}

export function normalizeComposioSkillPreferences(value: unknown): ComposioSkillPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_COMPOSIO_SKILL_PREFERENCES, connectedAccountIdsByToolkit: {} }
  }
  const raw = value as Record<string, unknown>
  const stringArray = (input: unknown): string[] =>
    Array.isArray(input)
      ? [
          ...new Set(
            input.filter((item): item is string => typeof item === 'string' && item.length > 0),
          ),
        ]
      : []
  const connectedAccountIdsByToolkit: Record<string, string> = {}
  if (
    raw.connectedAccountIdsByToolkit &&
    typeof raw.connectedAccountIdsByToolkit === 'object' &&
    !Array.isArray(raw.connectedAccountIdsByToolkit)
  ) {
    for (const [toolkitSlug, connectedAccountId] of Object.entries(
      raw.connectedAccountIdsByToolkit as Record<string, unknown>,
    )) {
      if (typeof connectedAccountId === 'string' && connectedAccountId) {
        connectedAccountIdsByToolkit[toolkitSlug] = connectedAccountId
      }
    }
  }
  const display =
    raw.display && typeof raw.display === 'object' && !Array.isArray(raw.display)
      ? (raw.display as Record<string, unknown>)
      : undefined
  return {
    disabledToolkitSlugs: stringArray(raw.disabledToolkitSlugs),
    disabledToolSlugs: stringArray(raw.disabledToolSlugs),
    connectedAccountIdsByToolkit,
    ...(display ? { display } : {}),
  }
}

function composioToolInputSchema(tool: ComposioTool): unknown {
  const functionParameters =
    tool.function && typeof tool.function === 'object'
      ? (tool.function as { parameters?: unknown }).parameters
      : undefined
  return tool.input_schema ?? tool.parameters ?? tool.schema ?? functionParameters ?? null
}

export async function listComposioManagedSkills(
  userId: string,
  client: Pick<
    ComposioClient,
    'listToolkits' | 'listAuthConfigs' | 'listConnectedAccounts' | 'createConnectLink'
  > &
    Partial<Pick<ComposioClient, 'listTools'>> = new ComposioClient(),
  logger?: ComposioLogger,
  preferences?: unknown,
  options?: { includeTools?: boolean },
): Promise<ComposioManagedSkill[]> {
  const normalizedPreferences = normalizeComposioSkillPreferences(preferences)
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
    if (!toolkitSlug || !isComposioAuthConfigEnabled(authConfig)) continue

    const toolkit = toolkitsBySlug.get(toolkitSlug)
    const preferredAccountId = normalizedPreferences.connectedAccountIdsByToolkit[toolkitSlug]
    const authConfigAccounts = connectedAccounts.filter(
      (candidate) => candidate.auth_config?.id === authConfig.id,
    )
    const account =
      (preferredAccountId &&
        authConfigAccounts.find((candidate) => candidate.id === preferredAccountId)) ||
      accountsByAuthConfig.get(authConfig.id)
    const rawStatus = accountStatus(account)
    const toolkitDisabled = normalizedPreferences.disabledToolkitSlugs.includes(toolkitSlug)
    const status =
      toolkitDisabled && rawStatus.status === 'enabled'
        ? { status: 'disabled' as const, connectionStatus: 'disabled' }
        : rawStatus
    let connectUrl: string | undefined
    if (status.status === 'needs_configuration') {
      try {
        connectUrl = (await client.createConnectLink(authConfig.id, userId)).redirect_url
      } catch (err) {
        logger?.warn(
          { err, authConfigId: authConfig.id, toolkitSlug },
          'composio connect link failed',
        )
      }
    }
    const tools =
      options?.includeTools && account && client.listTools
        ? (await client.listTools({ authConfigIds: authConfig.id })).map((tool) => {
            const slug = tool.slug
            const enabled =
              !toolkitDisabled && !normalizedPreferences.disabledToolSlugs.includes(slug)
            return {
              slug,
              name: tool.name,
              description: tool.description,
              toolkitSlug: tool.toolkit?.slug ?? toolkitSlug,
              inputSchema: composioToolInputSchema(tool),
              enabled,
            }
          })
        : undefined
    const enabledToolCount = tools?.filter((tool) => tool.enabled).length
    const disabledToolCount = tools?.filter((tool) => !tool.enabled).length

    skills.push({
      id: `composio-${toolkitSlug}`,
      name: toolkit?.name ?? authConfig.name ?? toolkitSlug,
      description:
        toolkit?.meta?.description ?? `Connect ${toolkit?.name ?? toolkitSlug} through Composio.`,
      logoUrl: toolkit?.meta?.logo ?? authConfig.toolkit?.logo,
      kind: account ? 'installed' : 'catalog',
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
      removable: rawStatus.status === 'enabled',
      configurable: rawStatus.status === 'enabled',
      enabledToolCount,
      disabledToolCount,
      tools,
    })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

export async function listExecutableComposioTools(
  userId: string,
  client: Pick<
    ComposioClient,
    'listAuthConfigs' | 'listConnectedAccounts' | 'listTools'
  > = new ComposioClient(),
  preferences?: unknown,
): Promise<ExecutableComposioTool[]> {
  const normalizedPreferences = normalizeComposioSkillPreferences(preferences)
  const [authConfigs, connectedAccounts] = await Promise.all([
    client.listAuthConfigs(),
    client.listConnectedAccounts(userId),
  ])

  const activeAccountsByAuthConfig = new Map<string, ComposioConnectedAccount>()
  for (const account of connectedAccounts) {
    const authConfigId = account.auth_config?.id
    if (authConfigId && isComposioConnectedAccountActive(account)) {
      activeAccountsByAuthConfig.set(authConfigId, account)
    }
  }

  const enabledConnectedAuthConfigs = authConfigs.filter((authConfig) => {
    const toolkitSlug = authConfig.toolkit?.slug
    return (
      isComposioAuthConfigEnabled(authConfig) &&
      activeAccountsByAuthConfig.has(authConfig.id) &&
      (!toolkitSlug || !normalizedPreferences.disabledToolkitSlugs.includes(toolkitSlug))
    )
  })
  if (enabledConnectedAuthConfigs.length === 0) return []

  const authConfigIds = enabledConnectedAuthConfigs.map((authConfig) => authConfig.id)
  const tools = await client.listTools({ authConfigIds: authConfigIds.join(',') })
  const authConfigsById = new Map(
    enabledConnectedAuthConfigs.map((authConfig) => [authConfig.id, authConfig]),
  )
  const authConfigByToolkit = new Map(
    enabledConnectedAuthConfigs
      .filter((authConfig) => authConfig.toolkit?.slug)
      .map((authConfig) => [authConfig.toolkit!.slug!, authConfig]),
  )

  const executable: ExecutableComposioTool[] = []
  for (const composioTool of tools) {
    const explicitAuthConfigId = composioTool.auth_config?.id
    const explicitToolkitSlug = composioTool.toolkit?.slug
    const authConfig =
      (explicitAuthConfigId && authConfigsById.get(explicitAuthConfigId)) ||
      (explicitToolkitSlug && authConfigByToolkit.get(explicitToolkitSlug)) ||
      (!explicitAuthConfigId && !explicitToolkitSlug && enabledConnectedAuthConfigs.length === 1
        ? enabledConnectedAuthConfigs[0]
        : undefined)
    const account = authConfig ? activeAccountsByAuthConfig.get(authConfig.id) : undefined
    if (!authConfig || !account) continue
    if (normalizedPreferences.disabledToolSlugs.includes(composioTool.slug)) continue
    executable.push({ tool: composioTool, authConfig, connectedAccount: account })
  }
  return executable
}

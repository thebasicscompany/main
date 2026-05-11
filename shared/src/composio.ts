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

export async function listComposioManagedSkills(
  userId: string,
  client: Pick<
    ComposioClient,
    'listToolkits' | 'listAuthConfigs' | 'listConnectedAccounts' | 'createConnectLink'
  > = new ComposioClient(),
  logger?: ComposioLogger,
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
    if (!toolkitSlug || !isComposioAuthConfigEnabled(authConfig)) continue

    const toolkit = toolkitsBySlug.get(toolkitSlug)
    const account = accountsByAuthConfig.get(authConfig.id)
    const status = accountStatus(account)
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

export async function listExecutableComposioTools(
  userId: string,
  client: Pick<
    ComposioClient,
    'listAuthConfigs' | 'listConnectedAccounts' | 'listTools'
  > = new ComposioClient(),
): Promise<ExecutableComposioTool[]> {
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

  const enabledConnectedAuthConfigs = authConfigs.filter(
    (authConfig) =>
      isComposioAuthConfigEnabled(authConfig) && activeAccountsByAuthConfig.has(authConfig.id),
  )
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
    executable.push({ tool: composioTool, authConfig, connectedAccount: account })
  }
  return executable
}

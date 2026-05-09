import type { Handler } from 'hono'
import { getConfig } from '../config.js'
import gatewayApp from '../gateway/index.js'
import { DatabaseUnavailableError } from '../lib/errors.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import type { AuthenticatedWorkspaceApiKey } from '../lib/workspace-api-keys.js'
import { recordUsage } from '../lib/metering.js'
import { teeForUsage } from '../lib/tee-for-usage.js'
import {
  extractFromJson,
  streamingExtractor,
  type ExtractedUsage,
  type ProviderKey,
} from '../lib/usage-extractors/index.js'
import { logger } from './logger.js'
import {
  NoCredentialError,
  resolveGatewayCredential,
  type GatewayCredentialTag,
} from '../orchestrator/credential-resolver.js'

/**
 * Bridge between the runtime's workspace JWT + KMS-encrypted credential store
 * and the Managed LLM Gateway. The gateway code is configured via request
 * headers (`x-basics-gw-provider`, plus provider-native auth headers). The
 * daemon hits us with a workspace JWT only; this handler resolves the
 * matching credential and forwards a rewritten request directly into the
 * gateway Hono app via `gatewayApp.fetch()`.
 *
 * Why fetch() instead of `app.route(prefix, gatewayApp)`:
 *   The daemon's URL embeds the provider slug
 *   (`/v1/llm/managed/<slug>/v1/messages`), but the gateway's internal routes
 *   are flat (`/v1/messages`). Hono's `app.route()` only strips the mount
 *   prefix, leaving `/<slug>/v1/messages` which the gateway can't match.
 *   Calling `gatewayApp.fetch(rewrittenRequest)` lets us hand the gateway
 *   exactly the URL it expects.
 *
 * Mount in app.ts:
 *   app.use('/v1/llm/managed/*', requireWorkspaceJwt)
 *   app.all('/v1/llm/managed/*', gatewayCredentialBridge)
 */

type Vars = {
  requestId: string
  workspace: WorkspaceToken
  apiKey?: AuthenticatedWorkspaceApiKey
  usageTag?: GatewayCredentialTag
}

/**
 * Map the URL slug the daemon uses (`/v1/llm/managed/<slug>/...`) to the
 * `kind` stored in `workspace_credentials.kind` and the upstream provider
 * identifier the gateway code expects in `x-basics-gw-provider`.
 *
 * Add a row when exposing a new provider through the managed gateway.
 */
const PROVIDER_BY_SLUG: Record<string, { kind: string; gatewayProvider: string }> = {
  anthropic: { kind: 'anthropic', gatewayProvider: 'anthropic' },
  openai: { kind: 'openai', gatewayProvider: 'openai' },
  gemini: { kind: 'gemini', gatewayProvider: 'google' },
}

function pooledKeyFor(
  cfg: ReturnType<typeof getConfig>,
  kind: string,
): string | undefined {
  switch (kind) {
    case 'anthropic':
      return cfg.ANTHROPIC_PLATFORM_KEY ?? cfg.ANTHROPIC_API_KEY
    case 'openai':
      return cfg.OPENAI_API_KEY
    case 'gemini':
      return cfg.GEMINI_API_KEY
    default:
      return undefined
  }
}

/**
 * Strip the `/v1/llm/managed/<slug>` prefix from the request URL so the
 * gateway sees a clean `/v1/<path>`.
 *
 *   in : /v1/llm/managed/anthropic/v1/messages
 *   out: /v1/messages
 */
function stripPrefix(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) return pathname
  const rest = pathname.slice(prefix.length)
  return rest.startsWith('/') ? rest : `/${rest}`
}

export const gatewayCredentialBridge: Handler<{ Variables: Vars }> = async (c) => {
  const url = new URL(c.req.url)
  // /v1/llm/managed/<slug>/... — segment 3 is the provider slug
  const segments = url.pathname.split('/').filter(Boolean)
  const slug = segments[3]
  const spec = slug ? PROVIDER_BY_SLUG[slug] : undefined
  if (!spec) {
    return c.json(
      { error: 'invalid_request', reason: 'unknown_provider', kind: slug ?? null },
      400,
    )
  }

  const cfg = getConfig()
  const ws = c.var.workspace
  let resolved
  try {
    resolved = await resolveGatewayCredential({
      workspaceId: ws.workspace_id,
      kind: spec.kind,
      pooledKey: pooledKeyFor(cfg, spec.kind),
    })
  } catch (e) {
    if (e instanceof NoCredentialError) {
      return c.json({ error: 'no_credential', kind: spec.kind }, 503)
    }
    if (e instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured' }, 503)
    }
    // Generic DB / network failures during credential resolve (Drizzle wraps
    // upstream Postgres errors). Surface as 503 so callers retry instead of
    // treating it as our internal_error.
    const msg = e instanceof Error ? e.message : ''
    if (
      msg.includes('Failed query') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT')
    ) {
      logger.error(
        { err: e, kind: spec.kind, ws: ws.workspace_id },
        'gateway-credential-bridge: db error during resolve',
      )
      return c.json({ error: 'db_unavailable', kind: spec.kind }, 503)
    }
    logger.error({ err: e }, 'gateway-credential-bridge: resolve failed')
    return c.json({ error: 'internal_error' }, 500)
  }

  c.set('usageTag', resolved.usageTag)

  // Rewrite headers + URL for the gateway. We:
  //   - Drop the daemon's `Authorization: Bearer <workspace-jwt>` so the
  //     gateway code does not interpret it as a provider key.
  //   - Set `x-basics-gw-provider` (the prefix-renamed POWERED_BY header)
  //     so the gateway routes to the right provider config.
  //   - Set provider-native auth headers (`x-api-key` for Anthropic,
  //     `Authorization: Bearer` for OpenAI/Google fall through their per-
  //     provider api.ts which reads `providerOptions.apiKey`).
  //   - Strip the `/v1/llm/managed/<slug>` prefix from the URL so the
  //     gateway sees its native flat routes (`/v1/messages`, etc).
  const headers = new Headers(c.req.raw.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  headers.set('x-basics-gw-provider', spec.gatewayProvider)
  // Generic Bearer key — read by gateway's `constructConfigFromRequestHeaders`
  // as `apiKey`. Anthropic also reads `x-api-key` directly per its per-provider
  // headers function; set both so either path works.
  headers.set('authorization', `Bearer ${resolved.plaintext}`)
  if (spec.gatewayProvider === 'anthropic') {
    headers.set('x-api-key', resolved.plaintext)
  }
  // Tag for downstream metering hooks (filled in by G3).
  if (resolved.credentialId) {
    headers.set('x-basics-credential-id', resolved.credentialId)
  }
  headers.set('x-basics-usage-tag', resolved.usageTag)

  const newPath = stripPrefix(url.pathname, `/v1/llm/managed/${slug}`)
  const newUrl = `${url.origin}${newPath}${url.search}`
  const rewritten = new Request(newUrl, {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    // duplex required when forwarding a streaming body; not in standard RequestInit yet
    duplex: 'half',
  } as RequestInit)

  // Hand the rewritten request directly to the gateway Hono app and pipe
  // the response back. Bypasses Hono's mount-prefix routing entirely.
  const upstream = await gatewayApp.fetch(rewritten)

  // Only meter successful provider responses; client errors (4xx) and
  // upstream failures (5xx) shouldn't be billed and may not contain usage.
  if (!upstream.ok) return upstream

  const provider = spec.gatewayProvider as ProviderKey
  const meteringMeta = {
    workspaceId: ws.workspace_id,
    accountId: ws.account_id,
    provider,
    usageTag: resolved.usageTag,
    credentialId: resolved.credentialId,
    apiKeyId: c.var.apiKey?.id ?? null,
    requestId: c.get('requestId'),
  }

  const contentType = upstream.headers.get('content-type') ?? ''

  if (contentType.includes('text/event-stream')) {
    // Streaming path: tee the body so bytes flow through to the client
    // unchanged while a stateful extractor accumulates usage.
    const extractor = streamingExtractor(provider)
    return teeForUsage(upstream, extractor, (usage) =>
      emitUsage(usage, meteringMeta),
    )
  }

  if (contentType.includes('application/json')) {
    // Non-streaming JSON: clone, parse, fire-and-forget meter without
    // delaying the client response.
    const cloned = upstream.clone()
    void cloned
      .json()
      .then((body) => extractFromJson(provider, body))
      .then((usage) => emitUsage(usage, meteringMeta))
      .catch((err) => {
        logger.warn({ err, ...meteringMeta }, 'gateway-meter: json parse failed')
      })
  }

  return upstream
}

/**
 * Fan one ExtractedUsage out into the runtime's usage_events table.
 * Three rows max: input_tokens, output_tokens, and (Anthropic only)
 * cache breakdowns. recordUsage() swallows DB errors internally so we
 * never break the user response on a metering hiccup.
 */
async function emitUsage(
  usage: ExtractedUsage | null,
  meta: {
    workspaceId: string
    accountId: string
    provider: ProviderKey
    usageTag: GatewayCredentialTag
    credentialId: string | null
    apiKeyId: string | null
    requestId: string
  },
): Promise<void> {
  if (!usage) return
  const metadata = {
    credential_usage_tag: meta.usageTag,
    credential_id: meta.credentialId,
    api_key_id: meta.apiKeyId,
    request_id: meta.requestId,
  }
  const common = {
    workspaceId: meta.workspaceId,
    accountId: meta.accountId,
    unit: 'tokens',
    provider: meta.provider,
    model: usage.model,
    metadata,
  }
  if (usage.inputTokens > 0) {
    await recordUsage({ ...common, kind: 'llm_input_tokens', quantity: usage.inputTokens })
  }
  if (usage.outputTokens > 0) {
    await recordUsage({ ...common, kind: 'llm_output_tokens', quantity: usage.outputTokens })
  }
  if (usage.cacheReadInputTokens && usage.cacheReadInputTokens > 0) {
    await recordUsage({
      ...common,
      kind: 'llm_cache_read_input_tokens',
      quantity: usage.cacheReadInputTokens,
    })
  }
  if (usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0) {
    await recordUsage({
      ...common,
      kind: 'llm_cache_creation_input_tokens',
      quantity: usage.cacheCreationInputTokens,
    })
  }
}

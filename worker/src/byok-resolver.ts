// CLOUD-AGENT-PLAN §6.2 + §20.3 — BYO API key resolution.
//
// Storage: workspaces.agent_settings.byoApiKeys = { anthropic?, google?,
// openai? }. Encrypt-at-rest with workspace-scoped KMS data keys is the
// other team's responsibility (§0.1). The worker treats the values as
// plaintext at the resolver boundary; the encrypt/decrypt seam lives in
// the api endpoint that the production HttpBYOKeyResolver hits.
//
// At run start the worker calls resolver.resolve(workspaceId) → keys.
// During selectModel/turn dispatch, resolveKeyForProvider() picks BYO
// when present, else falls back to the Doppler-injected platform env.

import type { Provider } from "./router/selectModel.js";

export interface BYOKeySet {
  anthropic?: string;
  google?: string;
  openai?: string;
}

export interface BYOKeyResolver {
  resolve(workspaceId: string): Promise<BYOKeySet>;
}

const PROVIDER_TO_PLATFORM_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

export interface ResolvedKey {
  provider: Provider;
  key: string;
  source: "byo" | "platform";
}

/**
 * Pick the right key for a single provider call.
 *   - BYO wins if present in the set
 *   - Else the platform env var (ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY)
 *   - Throws if neither — caller surfaces 'provider_unavailable'
 */
export function resolveKeyForProvider(
  provider: Provider,
  byo: BYOKeySet,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKey {
  const byoKey = byo[provider];
  if (byoKey && byoKey.length > 0) {
    return { provider, key: byoKey, source: "byo" };
  }
  const platformKey = env[PROVIDER_TO_PLATFORM_ENV[provider]];
  if (platformKey && platformKey.length > 0) {
    return { provider, key: platformKey, source: "platform" };
  }
  throw new Error(
    `provider_unavailable: ${provider} has no BYO key and no platform key (env ${PROVIDER_TO_PLATFORM_ENV[provider]})`,
  );
}

/** Tests + dev: hand-set the keys per workspace. */
export class InMemoryBYOKeyResolver implements BYOKeyResolver {
  private readonly byo = new Map<string, BYOKeySet>();

  set(workspaceId: string, keys: BYOKeySet): void {
    this.byo.set(workspaceId, keys);
  }

  clear(workspaceId: string): void {
    this.byo.delete(workspaceId);
  }

  async resolve(workspaceId: string): Promise<BYOKeySet> {
    return this.byo.get(workspaceId) ?? {};
  }
}

/**
 * Production resolver — calls the api's BYO key endpoint with a
 * service-role-ish auth token. The api decrypts via KMS and returns the
 * plaintext keys over TLS, never persisting them in the worker.
 *
 * Endpoint: GET /v1/runtime/byo-keys?workspace_id=<uuid>
 *   Auth: X-Service-Role-Token: <shared secret>
 *   Response: { anthropic?: string, google?: string, openai?: string }
 *
 * Per §0.1 the api endpoint is owned by the other team; this is the
 * consumer side. Throws when the endpoint isn't yet implemented.
 */
export interface HttpBYOKeyResolverOptions {
  apiBaseUrl: string;
  serviceRoleToken: string;
  fetchImpl?: typeof fetch;
}

export class HttpBYOKeyResolver implements BYOKeyResolver {
  private fetch: typeof fetch;
  constructor(private opts: HttpBYOKeyResolverOptions) {
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  async resolve(workspaceId: string): Promise<BYOKeySet> {
    const url = new URL("/v1/runtime/byo-keys", this.opts.apiBaseUrl);
    url.searchParams.set("workspace_id", workspaceId);
    const resp = await this.fetch(url, {
      method: "GET",
      headers: { "X-Service-Role-Token": this.opts.serviceRoleToken },
    });
    if (resp.status === 404) {
      // No BYO row for this workspace → empty set, fall back to platform.
      return {};
    }
    if (!resp.ok) {
      throw new Error(`byok_resolve_failed: ${resp.status} ${await resp.text()}`);
    }
    const body = (await resp.json()) as Partial<BYOKeySet>;
    return {
      ...(body.anthropic ? { anthropic: body.anthropic } : {}),
      ...(body.google ? { google: body.google } : {}),
      ...(body.openai ? { openai: body.openai } : {}),
    };
  }
}

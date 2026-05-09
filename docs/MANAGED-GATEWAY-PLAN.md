# Managed LLM Gateway — full-copy plan

**Status:** Draft. Companion to `docs/BYOK-PLAN.md`. Supersedes the prior harvest-style plan.
**Owner:** Arav (runtime).
**Date:** 2026-05-09.

---

## 0. TL;DR

We adopt a mature open-source AI gateway codebase (MIT licensed, Hono-based, ~30k LOC, production-grade) and copy it verbatim into `api/src/gateway/`. We mount it under `/v1/llm/managed/*`. We write one bridge middleware (~50 LOC) that turns our workspace JWT + `workspace_credentials` row into the upstream's `providerOptions`. That's it. No npm dependency on the upstream package; we own the code.

**Naming policy.** The upstream's product name appears only where MIT attribution legally requires it (LICENSE file copies, per-file "derived from" headers in the source we copied unchanged). All public identifiers, directory paths, route prefixes, doc titles, prose, and code symbols use neutral names: `gateway`, `managedLlmRoutes`, "Managed LLM Gateway".

**Why full-copy over npm-install:** simpler dependency graph, no version pinning surprises, ability to patch without forking, no upstream package version chasing. We were already going to maintain custom modifications; copying makes that explicit.

**Why this over harvest:** with the daemon and gateway both under our control in cloud modes, the wire format between them is a free choice. The upstream gateway already supports both byte-pass-through (`/v1/proxy/*`) and OpenAI-normalized (`/v1/chat/completions`). Both modes are battle-tested. Owning their code gives us the full surface — fallbacks, retries, 50+ providers, observability hooks, request validation — for the cost of one bridge middleware.

---

## 1. Naming and attribution policy

### 1.1 Public surface (no upstream brand)

| Where | Name |
|---|---|
| Directory | `api/src/gateway/` |
| Route prefix | `/v1/llm/managed/*` (unchanged from BYOK plan §7.2) |
| Hono app export | `gatewayApp` (default export from `api/src/gateway/index.ts`) |
| Bridge middleware | `gatewayCredentialBridge` |
| Config keys | `GATEWAY_*` |
| Doc title | "Managed LLM Gateway" |
| This plan filename | `docs/MANAGED-GATEWAY-PLAN.md` |

### 1.2 Attribution surface (MIT-required, kept honest)

MIT compels us to retain the copyright notice in copies of substantial portions. We satisfy this in three places:

1. **`api/src/gateway/LICENSE`** — verbatim copy of the upstream `LICENSE` file. Required.
2. **`api/src/gateway/NOTICE.md`** — one-paragraph statement: "This directory contains code derived from <upstream project>, MIT licensed, pinned at commit `351692f`. Source: <URL>. Modifications are listed in this file." Then the modification list (see §6).
3. **Per-file headers on files we keep substantially unchanged.** Files we rewrite from scratch (e.g. our new bridge middleware) get no attribution because they aren't derived.

Code identifiers, README headings outside `NOTICE.md`, route paths, log lines, error messages, and CLAUDE.md guidance never name the upstream brand. If a curious reader greps for it, they find it only in `LICENSE`/`NOTICE.md`. That keeps the legal obligation watertight while preserving the user's ask.

### 1.3 The `vendor/` clone

`vendor/` stays gitignored. The local clone path `vendor/portkey-gateway/` keeps the upstream's repo name there because that's where we cloned it from — it never ships in the repo. `vendor/README.md` softens its language so even reading the workspace's local FS doesn't lead with the brand. Anyone re-cloning gets the upstream by URL, not by our naming.

---

## 2. The decision: full-copy + bridge

```
vendor/portkey-gateway/src/      →  api/src/gateway/                     (verbatim, then patched)
vendor/portkey-gateway/conf.json →  api/src/gateway/conf.json            (with our defaults)
vendor/portkey-gateway/LICENSE   →  api/src/gateway/LICENSE              (verbatim)
                                    api/src/gateway/NOTICE.md            (new — modification log)
                                    api/src/middleware/gateway-credential-bridge.ts  (new — ~50 LOC)
```

- Mount in `api/src/app.ts` after `requireWorkspaceJwt`:
  ```ts
  import gatewayApp from './gateway/index.js'
  import { gatewayCredentialBridge } from './middleware/gateway-credential-bridge.js'

  app.use('/v1/llm/managed/*', requireWorkspaceJwt, gatewayCredentialBridge)
  app.route('/v1/llm/managed', gatewayApp)
  ```

- Daemon and orchestrator continue to think they hit `/v1/llm/managed/anthropic/v1/messages` etc. The gateway code routes upstream.

---

## 3. What gets copied

Everything under `vendor/portkey-gateway/src/` lands under `api/src/gateway/`, then we patch the few things that don't fit our environment (§6).

| Subtree | Copy? | Why |
|---|---|---|
| `src/handlers/` (all handlers) | yes | Our route surface; tree-shaking handles dead routes if any |
| `src/providers/` (all 50+) | yes | Free providers for future use; minimal cost (no runtime overhead unless invoked) |
| `src/middlewares/` (validator, hooks, cache, log) | yes | Useful infrastructure; we'll selectively enable |
| `src/services/` (transformers, conditional router, realtime parser) | yes | Used by handlers we copied |
| `src/shared/` | yes | Used by handlers |
| `src/utils.ts`, `src/utils/`, `src/globals.ts`, `src/types/`, `src/errors/`, `src/data/` | yes | Used everywhere |
| `src/apm/` | replace | Swap their logger for our `pino` instance (~10 LOC change). See §6 |
| `src/index.ts` | patch | Strip Cloudflare/Wrangler runtime branch and WebSocket realtime. See §6 |
| `src/start-server.ts` | drop | Their standalone Node entry; we mount under our app |
| `src/public/` | drop unless they ship anything we serve; check at copy time | Static assets — likely empty/optional |
| `src/tests/` | drop initially; revisit | Their integration tests use Jest + custom config; porting later if needed |
| `conf.json`, `conf.example.json` | yes (with our defaults) | Runtime knobs |

### What we deliberately do NOT copy

| Item | Reason |
|---|---|
| `vendor/portkey-gateway/plugins/` | Guardrails (PII, content filter, schema validation, etc.). Separate build pipeline. Add later when product wants safety filters. |
| `vendor/portkey-gateway/cookbook/` | Examples, not runtime code |
| `vendor/portkey-gateway/docs/` | Their docs |
| `vendor/portkey-gateway/tests/` | Top-level integration tests; Jest+Wrangler-based |
| `vendor/portkey-gateway/wrangler.toml`, `Dockerfile`, `deployment.yaml`, `docker-compose.yaml` | Their deployment topology; we use SST→Fargate |
| `vendor/portkey-gateway/rollup.config.js`, `jest.config.js`, `eslint.config.js`, `.prettierrc` | Their build/test/lint config; we use `tsc`, Vitest, our own ESLint/Prettier |
| `vendor/portkey-gateway/.github/`, `.husky/`, `.vscode/` | Their CI/IDE setup |
| `vendor/portkey-gateway/initializeSettings.ts` | Their bootstrap; we run inside our app |

### Dependencies we add to `api/package.json`

Diff their `package.json` against ours and add the missing runtime deps. Expected additions (verify at copy time):

- `@aws-crypto/sha256-js` (Bedrock signing)
- `@cfworker/json-schema` (request validator)
- `@portkey-ai/mustache` (prompt templates) — note: this is an npm package they own; if we want to avoid the brand entirely in our deps tree we can fork+rename, but that's overkill for an internal dep name. The package's *internal* presence in `node_modules` doesn't appear in our source. Recommend: keep the dep as-is.
- `@smithy/signature-v4` (AWS auth)
- `@types/mustache` (types)
- a few smaller utilities — exhaustive list at copy time

We already have `hono`, `zod`, `@hono/zod-validator`. Their other Hono extensions (`@hono/node-ws`, `@hono/node-server`) — `node-server` we don't need (we mount, don't host); `node-ws` only if we enable realtime later (skip now).

**Build-time:** add their TS path mappings if any; otherwise our `tsconfig.build.json` should compile their tree as-is since both projects target ESM + modern Node.

---

## 4. The credential bridge — the only original code

This is the hinge. The upstream gateway expects credentials via request headers (e.g. `x-portkey-api-key`, `x-portkey-virtual-key`, or per-provider headers). We have a JWT-authenticated workspace and `workspace_credentials` rows. The bridge converts.

```ts
// api/src/middleware/gateway-credential-bridge.ts
import type { MiddlewareHandler } from 'hono'
import { getConfig } from '../config.js'
import { resolveGatewayCredential, NoCredentialError } from '../orchestrator/credential-resolver.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

const PROVIDER_FROM_PATH: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  // …extend as we expose more upstream providers
}

export const gatewayCredentialBridge: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const segs = new URL(c.req.url).pathname.split('/').filter(Boolean)
  // /v1/llm/managed/<provider>/...
  const providerSlug = segs[3]
  const provider = PROVIDER_FROM_PATH[providerSlug]
  if (!provider) return c.json({ error: 'unknown_provider', kind: providerSlug }, 400)

  const cfg = getConfig()
  let resolved
  try {
    resolved = await resolveGatewayCredential({
      workspaceId: c.var.workspace.workspace_id,
      kind: provider,
      pooledKey: pooledKeyFor(cfg, provider),
    })
  } catch (e) {
    if (e instanceof NoCredentialError) {
      return c.json({ error: 'no_credential', kind: providerSlug }, 503)
    }
    throw e
  }

  // Inject the headers the upstream gateway code expects. We rewrite the
  // request before letting the gateway app handle it — same effect as the
  // client having sent them itself, minus the "client carries provider keys"
  // attack surface.
  const req = c.req.raw
  const headers = new Headers(req.headers)
  headers.set('x-portkey-provider', provider) // upstream expects this slug
  headers.set('x-portkey-api-key', resolved.plaintext) // single-provider auth path
  // Tag for our metering; upstream forwards unknown x-* headers in its log
  // pipeline if we wire that, otherwise we read it back in afterRequest hook.
  headers.set('x-basics-credential-id', resolved.credentialId ?? '')
  headers.set('x-basics-usage-tag', resolved.usageTag)

  // Replace the raw request the upstream sees:
  ;(c.req as unknown as { raw: Request }).raw = new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error duplex required for streaming bodies
    duplex: 'half',
  })

  await next()
}

function pooledKeyFor(cfg: ReturnType<typeof getConfig>, provider: string): string | undefined {
  switch (provider) {
    case 'anthropic': return cfg.ANTHROPIC_PLATFORM_KEY ?? cfg.ANTHROPIC_API_KEY
    case 'openai':    return cfg.OPENAI_API_KEY
    case 'google':    return cfg.GEMINI_API_KEY
    default:          return undefined
  }
}
```

**The exact header names the upstream expects** are confirmed at copy time by reading `api/src/gateway/handlers/handlerUtils.ts:constructConfigFromRequestHeaders` after the copy. We may need a second header for the provider name (`x-portkey-provider`) or we may put it in `providerOptions` — implementation detail confirmed during Phase 1.

**Metering hook.** After `next()`, the upstream's response is in `c.res`. We read `x-basics-usage-tag`, parse the response (or hook into the gateway's after-request hook) for `usage`, and call `recordUsage()` with the tag. This replaces the per-handler `fireAndForgetAnthropicMeter` / `meterOpenAiJson` / `meterGeminiJson` blocks in today's `routes/llm-proxy.ts`.

---

## 5. What this lets us delete from our existing code

Today's `api/src/routes/llm-proxy.ts` (~350 LOC) is replaced by the mount + bridge:

- `app.route('/v1/llm/managed', gatewayApp)` (1 LOC in `app.ts`)
- `gatewayCredentialBridge` (~50 LOC)
- Metering hook (~30 LOC, replaces three meter helpers)

Net: `routes/llm-proxy.ts` is **deleted**. Net code change: −350 + ~80 = ~−270 LOC of our code, plus ~30k LOC of upstream code we now own.

`routes/llm-proxy.test.ts` is rewritten to test the bridge + mount path, not the per-handler logic. ~150 LOC → ~80 LOC of test.

What stays unchanged from BYOK plan:
- `api/src/routes/credentials.ts` — credential CRUD
- `api/src/lib/kms.ts` — encryption
- `api/src/orchestrator/credential-resolver.ts` — `resolveActiveCredential` (orchestrator path) and `resolveGatewayCredential` (gateway path; bridge calls this)
- `api/src/lib/anthropic.ts:getAnthropicClientForWorkspace` — orchestrator's `agentLoop.ts` keeps direct Anthropic SDK; not routed through the gateway
- `api/src/lib/gemini.ts`, `api/src/routes/llm.ts` — same; the runtime's own `/v1/llm` Gemini route is unchanged
- All `workspace_credentials` schema and migrations

---

## 6. Modifications to copied code (the small list)

This list lives in `api/src/gateway/NOTICE.md` after H1.

1. **`api/src/gateway/index.ts`**
   - Drop the Cloudflare Workers runtime detection branch (`if (runtime === 'workerd')` realtime mount)
   - Drop the `compress()` middleware setup branch (we run on Node behind a load balancer; compression upstream)
   - Drop the `if (runtime === 'node' && process.env.REDIS_CONNECTION_STRING)` block (we don't use their Redis cache layer)
   - Drop the WebSocket realtime route
   - Drop the static asset serving for `/v1/models` if it pulls from a Workers KV; if it's pure code, keep
   - Default `export default app` stays — we mount it from our `app.ts`

2. **`api/src/gateway/apm/index.ts`** (or equivalent logger)
   - Replace their logger wrapper with a thin shim around our pino logger:
     ```ts
     import { logger as pinoLogger } from '../../middleware/logger.js'
     export const logger = {
       info: (...args: unknown[]) => pinoLogger.info({ src: 'gateway' }, args.map(String).join(' ')),
       warn: (...args: unknown[]) => pinoLogger.warn({ src: 'gateway' }, args.map(String).join(' ')),
       error: (...args: unknown[]) => pinoLogger.error({ src: 'gateway' }, args.map(String).join(' ')),
       debug: (...args: unknown[]) => pinoLogger.debug({ src: 'gateway' }, args.map(String).join(' ')),
     }
     ```

3. **`api/src/gateway/conf.json`**
   - Set `cache: false` (we don't run their response cache; that would be wrong layer for our use)
   - Other defaults left at upstream's recommendation

4. **`api/src/gateway/middlewares/log/index.ts`** (or wherever)
   - If they have a separate request log, disable — our top-level `loggerMiddleware` already logs every request

5. **String replacement pass: error messages and log lines**
   - Replace any user-visible string containing the upstream's product name with neutral copy. Targets: `errors/RouterError.ts`, error-shape JSON returned to clients (`{ status: 'failure', message: ... }` blocks).
   - Internal comments are fine to keep (developer-facing only).

6. **TypeScript config**
   - Their tsconfig may differ. Verify their tree compiles under our `tsconfig.build.json`. If not, add their tree to `tsconfig.build.json`'s `include` and override with a `tsconfig.json` inside `api/src/gateway/` if a setting must differ.

That's the entire modification list. Six items.

---

## 7. Mounting in `app.ts`

```ts
// api/src/app.ts diff (illustrative)

  import { credentialRoutes } from './routes/credentials.js'
- import { managedLlmRoutes } from './routes/llm-proxy.js'
+ import gatewayApp from './gateway/index.js'
+ import { gatewayCredentialBridge } from './middleware/gateway-credential-bridge.js'

   …

   app.use('/v1/llm/*', requireWorkspaceJwt)
-  app.route('/v1/llm/managed', managedLlmRoutes)
+  app.use('/v1/llm/managed/*', gatewayCredentialBridge)
+  app.route('/v1/llm/managed', gatewayApp)
   app.route('/v1/llm', llmRoute)
```

Order: `requireWorkspaceJwt` (already wildcarded for `/v1/llm/*`) → `gatewayCredentialBridge` → mounted gateway app. Workspace identity comes from JWT before credentials are resolved.

Then delete `api/src/routes/llm-proxy.ts` and its test file.

---

## 8. Phased execution

### Phase G1 — Copy + compile (M, ~1 day)

- `cp -r vendor/portkey-gateway/src/* api/src/gateway/`
- `cp vendor/portkey-gateway/{conf.json,LICENSE} api/src/gateway/`
- Author `api/src/gateway/NOTICE.md` per §1.2.
- Drop the files listed in §3 "do not copy" if they slipped in.
- Diff `vendor/portkey-gateway/package.json` against `api/package.json`; add missing deps.
- Apply modifications #1, #2, #3, #4, #6 from §6.
- `pnpm typecheck` clean. `pnpm build` clean.

**Acceptance:** entire `api/src/gateway/` tree compiles; no runtime behavior change yet (gateway not mounted); existing 392 tests still pass.

### Phase G2 — Bridge middleware + mount (M, ~1 day)

- Author `api/src/middleware/gateway-credential-bridge.ts`.
- Verify exact header contract by reading `api/src/gateway/handlers/handlerUtils.ts:constructConfigFromRequestHeaders` post-copy. Adjust bridge accordingly.
- Mount per §7.
- Delete `api/src/routes/llm-proxy.ts` and its test.
- Author `api/src/middleware/gateway-credential-bridge.test.ts`:
  - Auth header injection per provider
  - Workspace JWT mismatch → 403
  - No credential → 503
  - DB unavailable → 503
- Manual integration test against staging: `POST /v1/llm/managed/anthropic/v1/messages` with a workspace BYOK Anthropic key resolves correctly; response stream piped to client.

**Acceptance:**
- Pre-existing daemon flow (managed-mode call → gateway → upstream) works unchanged from the daemon's POV.
- A staging streaming Anthropic completion produces a streamed response; metering hook (Phase G3) is the only thing not yet wired.
- `pnpm test --filter api` green.

### Phase G3 — Metering hook (M, ~1 day)

- Add an after-request hook in the bridge (or as a wrapper around `gatewayApp`) that reads `usage` from the upstream response.
- For non-streaming: parse JSON, read `usage.{input,output}_tokens` (Anthropic) / `usage.{prompt,completion}_tokens` (OpenAI) / `usageMetadata.{promptTokenCount,candidatesTokenCount}` (Google).
- For streaming: tee the response body through the upstream's existing chunk parsers (they are already in the copied tree) and accumulate usage.
- Fire `recordUsage()` with `credential_usage_tag` from the bridge.

**Acceptance:**
- Streaming requests produce `usage_events` rows with correct totals (the audit's P0 streaming-meter gap is closed).
- Non-streaming behavior unchanged from current.

### Phase G4 — String/identifier rename pass (S, ~½ day)

- `pnpm exec rg -i 'portkey' api/src/gateway/` → audit each hit
- Identifiers, route prefixes, log lines, exported symbols, JSON error fields → neutralize per §1.1
- Internal comments + `LICENSE` + `NOTICE.md` may keep references (attribution)
- Add a CI grep: fail build if `api/src/` (excluding `gateway/LICENSE`, `gateway/NOTICE.md`, and per-file source-attribution headers) contains the upstream brand

**Acceptance:**
- `pnpm exec rg -i 'portkey' api/src/ --glob '!gateway/LICENSE' --glob '!gateway/NOTICE.md' --glob '!**/*.derived.ts'` returns nothing OR only matches we explicitly allowlist.

### Phase G5 — Optional: enable upstream features (deferred, by need)

Things the upstream supports that we now own but don't enable in G1–G4:

- Fallbacks (Anthropic 5xx → fall back to OpenAI). Requires daemon UX decision.
- Cache layer (response cache). Wrong layer for managed-pooled billing; revisit if non-billable utility traffic emerges.
- Guardrails (PII filter, content filter). Requires legal/policy input.
- 50+ providers beyond Anthropic/OpenAI/Google. Add by adding daemon UI.
- WebSocket realtime. Add when daemon exposes it.
- Conditional router (per-tenant model routing rules). Possibly useful for managed-mode model selection per BYOK §6.3.

Each of these is "uncomment a config flag or wire one route" once G1 lands, because the code is already there.

### Total

~3 days through G4. G5 items unlock incrementally as product needs arise — at near-zero marginal cost since the code is already in our tree.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| ~30k LOC of code we own but didn't write | Accepted tradeoff. The code is well-tested upstream (their CI runs Jest on every PR). Upstream bugs become our bugs but the surface is small (~10 hot files). |
| Upstream evolves; we miss security fixes | Quarterly diff-merge from upstream into `api/src/gateway/`. The pinned SHA in `vendor/README.md` is the merge base. Modifications log in `NOTICE.md` is what to re-apply. |
| Their TS config / module resolution doesn't match ours | Phase G1 covers this; if it fights, scope a `gateway/tsconfig.json` override |
| Their Hono version drifts from ours | Both pinned in `package.json`; if they upgrade Hono and we don't, copy their version. Hono is small, low blast radius |
| String-rename pass misses something | CI grep in G4 is the catch |
| MIT attribution slips | `LICENSE` + `NOTICE.md` are mandatory artifacts of G1; CI check that they exist |
| Bridge middleware contract drifts as upstream evolves header parsing | Pin a contract test: bridge sets header X, gateway reads header X, response includes upstream's identifier in body. Breaks loud on upstream change |

---

## 10. Decision log

- **2026-05-09** — Adopted full-copy over npm-install. Driver: avoid version-pinning surprises, ability to patch in place, explicit ownership.
- **2026-05-09** — Adopted full-copy over selective harvest. Driver: with both daemon and gateway under our control, wire format is a free choice; owning the full upstream surface is cheap and gives us 50+ providers, fallbacks, retries, observability.
- **2026-05-09** — Naming policy: neutral identifiers and paths everywhere; upstream brand only in MIT-required attribution (`LICENSE`, `NOTICE.md`, per-file source-attribution headers on substantially-unchanged files).
- **2026-05-09** — Surface B (orchestrator computer-use) **does not** route through the gateway. Direct Anthropic SDK in `agentLoop.ts` stays. Reason: 32MB screenshots × in-process call is faster than round-tripping through our own gateway; Surface B has one provider with native features (computer-use beta, prompt cache control) heavily exercised.
- **2026-05-09** — `vendor/portkey-gateway/` clone path stays as-is (gitignored, never ships). The local FS path mirrors upstream's repo name; this aids "where did this come from" without polluting the shipping repo.
- **OPEN** — Whether to tee streaming body for usage extraction inside the bridge, or wire upstream's existing afterRequest hook system. Resolves in G3.
- **OPEN** — Exact header contract (`x-portkey-provider` vs body-injected provider name) — resolves in G2 by reading the post-copy code.
- **OPEN** — Whether to keep the `@portkey-ai/mustache` dep (an upstream-branded npm package) or fork+rename. Recommendation: keep as-is — internal dep names don't appear in our source.

---

## 11. Acceptance criteria for the overall plan

- `api/src/gateway/` exists, compiles, and is mounted under `/v1/llm/managed/*`.
- `api/src/routes/llm-proxy.ts` is deleted.
- `api/src/middleware/gateway-credential-bridge.ts` exists and tests pass.
- `pnpm exec rg -i 'portkey' api/src/ --glob '!gateway/LICENSE' --glob '!gateway/NOTICE.md'` returns no matches outside explicit attribution headers.
- `api/src/gateway/LICENSE` exists, byte-identical to upstream's.
- `api/src/gateway/NOTICE.md` exists and lists every modification per §6.
- Streaming requests through the gateway produce correctly-tagged `usage_events` rows.
- Non-streaming requests behave identically to today's `routes/llm-proxy.ts`.
- All 392 existing tests still pass; ~10–15 new tests cover the bridge.
- Daemon (`basics-assistant`) is unchanged. It continues to call `/v1/llm/managed/*` as before.
- Surface B orchestrator path (`agentLoop.ts` → Anthropic SDK direct) is unchanged.

---

## 12. Open questions to resolve before G1

1. **Does upstream's request validator reject our injected headers?** Some validators block unknown `x-*` headers. Read `api/src/gateway/middlewares/requestValidator/` post-copy; allowlist `x-basics-*` if needed.
2. **`@portkey-ai/mustache` dep — keep or replace?** Recommend keep; it's `node_modules`, not source.
3. **Conf.json schema** — diff `vendor/portkey-gateway/conf.example.json` and pick a baseline.
4. **Realtime route** — strip in G1 or leave dead-code-pathed? Recommend strip (less surface).
5. **Their `/v1/proxy/*` deprecated route** — strip in G1 or keep? Recommend keep (zero cost, useful for advanced clients).

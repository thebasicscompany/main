# BYOK & workspace credentials — implementation plan

**Status:** Draft for engineering audit + autonomous execution.
**Owner:** Arav (control plane); orchestrator coordinates on decrypt + runtime usage; desktop consumes via `basics-assistant`.
**Related:** `08-basics-cloud-requirements.md` §M6, §11 (BYOK Option A); this doc supersedes narrative only where it adds product clarity — schema/API should still match M6 unless this plan explicitly changes them.

> **How this plan is structured.** Part I frames the product (the three customer modes + monetization). Part II is the architecture and components. Part III is the **autonomous build plan** — eight self-contained phases, each runnable as a discrete `/gsd-autonomous` segment with explicit scope, file lists, and acceptance criteria.

---

# Part I — Product framing

## 1. The three customer modes (front and center)

Every customer interaction with Basics LLM functionality falls into exactly one of three modes per provider per workspace. **This is the product surface; everything in Part II implements it.**

### Mode A — Local BYOK (`local:your-own`)

- **What:** User runs the desktop daemon, pastes their own provider keys into the daemon. All LLM calls happen on the user's machine, hitting provider APIs directly.
- **Who picks the provider/model:** Customer.
- **Who pays the provider:** Customer (their Anthropic/OpenAI/Gemini bill).
- **Who pays Basics:** Free tier or Pro plan (platform-only price; no token markup).
- **Where keys live:** `~/.vellum/protected/keys.enc` (existing AES-256-GCM store).
- **Runtime involvement:** Zero. The runtime never sees these calls.
- **Best for:** Individual users, testing, privacy-conscious power users.

### Mode B — Cloud BYOK (`cloud:byok`)

- **What:** Workspace admin uploads provider keys to Basics Cloud. Cloud workflows (Browserbase / computer-use jobs) run on Basics' Fargate infra but call providers using *the workspace's own key*. Same applies to managed-proxy gateway calls from the daemon.
- **Who picks the provider/model:** Customer.
- **Who pays the provider:** Customer (their Anthropic/OpenAI/Gemini bill).
- **Who pays Basics:** Higher-tier plan (platform fee captures lost token margin — see §2).
- **Where keys live:** `workspace_credentials` table, encrypted at rest with AWS KMS, scoped to `workspace_id`.
- **Runtime involvement:** Stores, decrypts, injects into provider call. Never logs plaintext.
- **Best for:** Enterprise (compliance + audit), high-volume customers, customers with existing provider credits.

### Mode C — Managed (`cloud:managed`)

- **What:** Workspace has no BYOK keys. Cloud workflows and managed-proxy calls use Basics-controlled keys (per-workspace provisioned by Basics, or pooled platform key as fallback). Basics chooses provider and model server-side.
- **Who picks the provider/model:** **Basics**, per workload (agent loop / utility / embed).
- **Who pays the provider:** Basics.
- **Who pays Basics:** Bundled subscription (token cost rolled into plan price; markup is Basics' margin).
- **Where keys live:** Same `workspace_credentials` table with `provenance='basics_managed'`.
- **Runtime involvement:** Full — picks model, picks key, makes call, meters tokens.
- **Best for:** Teams that don't want to manage keys, predictable bundled bill, non-technical buyers, customers who trust Basics' model choices.

### Mode interaction (important)

A workspace is **not** strictly one mode globally. Modes are per-credential-row, per-provider:

> Workspace can be **Cloud BYOK on Anthropic** (their key for Claude calls) and **Managed on OpenAI/Gemini** (Basics' keys for everything else) simultaneously.

Resolution order in `cloud:` context (per provider):
1. `customer_byok` row with `status='active'` → use it.
2. `basics_managed` row with `status='active'` → use it.
3. `basics_managed` row with `status='not_provisioned'` → fall back to env platform pool.
4. None → `503 no_credential`.

---

## 2. Monetization model

The economic threat: if Cloud BYOK and Managed cost the same to the customer, sophisticated customers will all choose BYOK (cheaper for them, lower margin for Basics). The defense is **price discrimination**, not eliminating BYOK.

### 2.1 Pricing principles

| Mode | Plan tiers that allow it | Pricing logic |
|------|-------------------------|---------------|
| **Local BYOK** | Free, Pro, Team, Enterprise | Free or low platform-only price. No tokens involved. |
| **Cloud BYOK** | Team, Enterprise | Higher platform fee than Managed-equivalent (~1.3-1.5x) to recover lost token margin. Compliance and high-volume customers self-select. |
| **Managed** | Pro, Team, Enterprise | Bundled subscription with included token allowance; overage priced with Basics' markup. Default for new signups. |

### 2.2 Onboarding default

- New workspace defaults to **Managed**. BYOK is in Settings → Advanced, not in onboarding.
- BYOK option is **gated to Team plan and above**. Free and Pro see "Upgrade to use your own keys" if they look.
- Enterprise tier bundles BYOK + SSO + audit logs as a single value proposition — that's where compliance customers land.

### 2.3 What this plan delivers vs what billing owns

- **This plan delivers:** the technical capability to enforce "BYOK requires Team+ plan" via a `requireBYOKEntitlement` check on `POST /v1/workspaces/:id/credentials` with `provenance='customer_byok'`. The runtime reads the workspace's plan from a JWT claim or a `workspaces.plan` column.
- **This plan does NOT deliver:** Stripe integration, plan upgrade flows, dunning, or pricing-page UI. Those are billing's scope. Phase 8 (§13.8) is just the runtime enforcement glue.

### 2.4 Don't kill BYOK

The instinct to make Managed the only option is wrong. Killing BYOK doesn't convert those customers to Managed — they walk to Cursor / Continue / a competitor that supports BYOK. You lose:
- Compliance-bound enterprises (your highest contracts).
- High-volume customers who run the math.
- Customers with existing provider credits.

Price BYOK to recover margin; don't ban it.

---

# Part II — Architecture & components

## 3. Two LLM call surfaces

The Basics product makes LLM calls from **two distinct places**. Both share the credential store and KMS layer; they differ only in where the call originates.

### Surface A — Desktop daemon (local LLM calls)

- Lives in `basics-assistant`, runs as a local process on the user's machine.
- Powers: conversation agent loop, memory compaction, embeddings, rollups, feed-title rewriting, command preview, context window manager.
- Six providers built in: Anthropic, OpenAI, Gemini, Ollama, Fireworks, OpenRouter.
- Local key store: `~/.vellum/protected/keys.enc` (AES-256-GCM, derived key in `~/.vellum/protected/store.key`).
- **Mode A (Local BYOK):** daemon hits provider APIs directly. **Runtime never sees the call.**
- **Mode B/C (Cloud BYOK / Managed):** daemon hits the runtime managed-proxy gateway (§7). Runtime picks (or honors) provider/model, injects key, meters.

### Surface B — Runtime cloud workflows (server-side LLM calls)

- Lives in `basics/runtime/api/src/orchestrator/`, runs on Fargate.
- Powers: Browserbase / computer-use workflows that can't run on the user's machine; future server-only automations.
- Anthropic-only today (computer-use beta); §6.2 adds workspace-scoped key resolution.
- **Mode B (Cloud BYOK):** orchestrator uses workspace's uploaded Anthropic key.
- **Mode C (Managed):** orchestrator uses Basics-pooled (or per-workspace provisioned) Anthropic key; Basics chooses model.

### Shared substrate

| Layer | Both surfaces share |
|-------|--------------------|
| `workspace_credentials` table (§4) | Same source of truth for keys |
| KMS module (§5) | Same encryption/decryption |
| Credential CRUD API (§5.4) | Admin uploads once; both surfaces benefit |
| Resolver (§6.1) | Same lookup function |

When an admin uploads a BYOK Anthropic key, *both* the cloud workflow and the managed-proxy gateway pick it up. Single source of truth.

---

## 4. Tech stack & current state (anchor)

The runtime is already chosen. **Do not introduce new frameworks** for BYOK.

| Layer | Tool | Version | Notes |
|-------|------|---------|-------|
| Language | TypeScript | 5.8.3 (ESM) | `tsc -p tsconfig.build.json`, `tsx watch` for dev |
| HTTP | Hono | 4.12.x | `new Hono<{ Variables: Vars }>()`, `zValidator` for input |
| Validation | Zod (via `@hono/zod-validator`) | — | All request bodies validated |
| ORM | Drizzle | 0.45.x + drizzle-kit 0.31.x | Schema in `api/src/db/schema-public.ts`; migrations in `api/drizzle/NNNN_*.sql` |
| DB | Postgres (Supabase) | — | DDL via `SUPABASE_MIGRATION_URL` (session pooler) |
| AWS SDK | v3 (`@aws-sdk/client-kms` 3.744) | — | Already imported; no KMS code yet |
| Auth | Workspace JWT (HS256, 24h) | — | `requireWorkspaceJwt` middleware; workspace on `c.var.workspace` |
| RBAC | None today | — | Added by Phase 1 |
| Worker | In-process orchestrator | — | `api/src/orchestrator/`; same Fargate process as API |
| Runtime AI SDKs | Anthropic 0.95, Gemini (`@google/genai`) 1.50, Deepgram 5.0 | — | Anthropic + Gemini are singletons today — see §6.2 |
| Tests | Vitest | 4.1.x | Colocated `*.test.ts`; `freshApp()` + `__resetConfigForTests()` |
| Deploy | SST → ECS/Fargate | — | Task role provides AWS creds |

**Existing schema** (`api/src/db/schema-public.ts:workspaceCredentials`): exists but lacks `provenance` and `status` columns. Phase 1 adds them.

**Existing desktop** (`basics-assistant`): six-provider stack with AES-256-GCM key store and `services.inference.mode: "managed" | "your-own"` flag wired to `resolveProviderCredentials()` in `assistant/src/providers/registry.ts`. **The plan does not change the desktop's local-LLM behavior.**

---

## 5. Schema, KMS, and Credentials API

### 5.1 Schema (Phase 1 target)

```typescript
// api/src/db/schema-public.ts
export const workspaceCredentials = pgTable('workspace_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  kind: text('kind').notNull(),                  // 'anthropic' | 'openai' | 'gemini' | 'deepgram' | …
  label: text('label').notNull().default(''),
  provenance: text('provenance').notNull(),      // 'basics_managed' | 'customer_byok'
  status: text('status').notNull(),              // 'active' | 'not_provisioned' | 'cleared'
  ciphertext: bytea('ciphertext'),               // NULL when status != 'active'
  kmsKeyId: text('kms_key_id').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  lastProviderError: text('last_provider_error'),
  lastProviderErrorAt: timestamp('last_provider_error_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('workspace_credentials_unique_kind_label').on(t.workspaceId, t.kind, t.label),
  index('workspace_credentials_workspace_active').on(t.workspaceId, t.status),
])
```

### 5.2 Migration SQL (`api/drizzle/NNNN_byok_provenance_status.sql`)

```sql
ALTER TABLE public.workspace_credentials
  ADD COLUMN provenance text,
  ADD COLUMN status text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_provider_error text,
  ADD COLUMN last_provider_error_at timestamptz;

UPDATE public.workspace_credentials
   SET provenance = 'customer_byok', status = 'active'
 WHERE provenance IS NULL;

ALTER TABLE public.workspace_credentials
  ALTER COLUMN provenance SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN ciphertext DROP NOT NULL;

ALTER TABLE public.workspace_credentials
  ADD CONSTRAINT workspace_credentials_provenance_check
    CHECK (provenance IN ('basics_managed', 'customer_byok')),
  ADD CONSTRAINT workspace_credentials_status_check
    CHECK (status IN ('active', 'not_provisioned', 'cleared')),
  ADD CONSTRAINT workspace_credentials_active_has_ciphertext
    CHECK (status <> 'active' OR ciphertext IS NOT NULL);

CREATE INDEX IF NOT EXISTS workspace_credentials_workspace_active
  ON public.workspace_credentials (workspace_id, status);
```

### 5.3 KMS module (`api/src/lib/kms.ts` — new)

- Stage-scoped alias: `alias/basics-byok-${stage}`. One CMK per stage. Set via `BYOK_KMS_KEY_ALIAS` env.
- Direct KMS Encrypt (not envelope) — API keys are < 4KB.
- Encryption context bound to `purpose=workspace_credential` (defense in depth).

```typescript
// api/src/lib/kms.ts
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms'
import { getConfig } from '../config'

let _client: KMSClient | null = null
function client(): KMSClient {
  if (!_client) _client = new KMSClient({ region: getConfig().AWS_REGION ?? 'us-east-1' })
  return _client
}

export function __resetKmsForTests() { _client = null }

export interface EncryptResult { ciphertext: Buffer; kmsKeyId: string }

export async function encryptCredential(plaintext: string, alias?: string): Promise<EncryptResult> {
  const KeyId = alias ?? getConfig().BYOK_KMS_KEY_ALIAS
  const out = await client().send(new EncryptCommand({
    KeyId,
    Plaintext: Buffer.from(plaintext, 'utf8'),
    EncryptionContext: { purpose: 'workspace_credential' },
  }))
  if (!out.CiphertextBlob || !out.KeyId) throw new Error('kms: encrypt returned empty')
  return { ciphertext: Buffer.from(out.CiphertextBlob), kmsKeyId: out.KeyId }
}

export async function decryptCredential(ciphertext: Buffer): Promise<string> {
  const out = await client().send(new DecryptCommand({
    CiphertextBlob: ciphertext,
    EncryptionContext: { purpose: 'workspace_credential' },
  }))
  if (!out.Plaintext) throw new Error('kms: decrypt returned empty')
  return Buffer.from(out.Plaintext).toString('utf8')
}
```

### 5.4 Credentials API (`api/src/routes/credentials.ts` — new)

Mounted at `/v1/workspaces/:workspaceId/credentials`. All routes guarded by `requireWorkspaceJwt` + `requireAdmin`.

#### Response shape

```typescript
interface CredentialMetadata {
  id: string
  workspaceId: string
  kind: string
  label: string
  provenance: 'basics_managed' | 'customer_byok'
  status: 'active' | 'not_provisioned' | 'cleared'
  createdAt: string
  updatedAt: string
  rotatedAt: string | null
  lastUsedAt: string | null
  lastProviderError: string | null
  lastProviderErrorAt: string | null
}
```

#### Endpoints

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| GET | `/v1/workspaces/:id/credentials` | JWT + admin | Returns `{ credentials: CredentialMetadata[] }`. 403 for member. |
| POST | `/v1/workspaces/:id/credentials` | JWT + admin + `requireBYOKEntitlement` (Phase 8) | Body: `{ kind, label?, plaintext, provenance? }`. Encrypts; upserts on `(workspace_id, kind, label)`. 409 if active row exists (use PATCH). |
| PATCH | `/v1/workspaces/:id/credentials/:credentialId` | JWT + admin | Body: `{ plaintext }` (rotation) or `{ label }` (rename). Re-encrypts on plaintext change; clears `lastProviderError`. |
| DELETE | `/v1/workspaces/:id/credentials/:credentialId` | JWT + admin | Sets `status='cleared'`, `ciphertext=NULL`. Row not dropped. 204. |

#### Mounting (`api/src/app.ts`)

```typescript
app.use('/v1/workspaces/*', requireWorkspaceJwt)
app.route('/v1/workspaces', credentialRoutes)
```

`credentialRoutes` checks `c.req.param('workspaceId') === c.var.workspace.workspaceId` → `403 workspace_mismatch` on mismatch.

### 5.5 IAM policy (Fargate task role)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "BYOKEncrypt",
    "Effect": "Allow",
    "Action": ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"],
    "Resource": "arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/*",
    "Condition": {
      "StringEquals": { "kms:EncryptionContext:purpose": "workspace_credential" },
      "ForAnyValue:StringEquals": {
        "kms:RequestAlias": [
          "alias/basics-byok-dev",
          "alias/basics-byok-staging",
          "alias/basics-byok-prod"
        ]
      }
    }
  }]
}
```

CMK key policy must allow `Encrypt`/`Decrypt` from the Fargate task role principal.

---

## 6. Resolution & orchestrator (Surface B)

### 6.1 Resolver (`api/src/orchestrator/credential-resolver.ts` — new)

```typescript
export class CredentialNotProvisionedError extends Error {
  constructor(public readonly meta: { workspaceId: string; kind: string }) {
    super(`no active credential for kind=${meta.kind}`)
  }
}

export async function resolveCredential(opts: {
  workspaceId: string
  kind: string
  label?: string
}): Promise<{ plaintext: string; provenance: string; credentialId: string }> {
  const row = await db.query.workspaceCredentials.findFirst({
    where: and(
      eq(workspaceCredentials.workspaceId, opts.workspaceId),
      eq(workspaceCredentials.kind, opts.kind),
      eq(workspaceCredentials.label, opts.label ?? ''),
      eq(workspaceCredentials.status, 'active'),
    ),
  })
  if (!row || !row.ciphertext) {
    throw new CredentialNotProvisionedError({ workspaceId: opts.workspaceId, kind: opts.kind })
  }
  const plaintext = await decryptCredential(row.ciphertext)
  await db.update(workspaceCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(workspaceCredentials.id, row.id))
    .catch((e) => log.warn('lastUsedAt update failed', e))
  return { plaintext, provenance: row.provenance, credentialId: row.id }
}
```

**No process-level plaintext cache in v1.** Add workspace-scoped LRU later if profiling demands. Never cache plaintext beyond the run.

### 6.2 Anthropic refactor (Phase 3)

`getAnthropicClient()` (`api/src/lib/anthropic.ts:52`) caches one instance from env. BYOK requires per-workspace keys.

```typescript
// api/src/lib/anthropic.ts
export interface AnthropicHandle {
  client: Anthropic
  credentialId: string | null
  provenance: 'basics_managed' | 'customer_byok' | 'env_fallback'
}

export async function getAnthropicClientForWorkspace(workspaceId: string): Promise<AnthropicHandle> {
  try {
    const resolved = await resolveCredential({ workspaceId, kind: 'anthropic' })
    return {
      client: new Anthropic({ apiKey: resolved.plaintext }),
      credentialId: resolved.credentialId,
      provenance: resolved.provenance as 'basics_managed' | 'customer_byok',
    }
  } catch (e) {
    if (!(e instanceof CredentialNotProvisionedError)) throw e
  }
  const platformKey = getConfig().ANTHROPIC_PLATFORM_KEY ?? getConfig().ANTHROPIC_API_KEY
  if (!platformKey) throw new CredentialNotProvisionedError({ workspaceId, kind: 'anthropic' })
  return { client: new Anthropic({ apiKey: platformKey }), credentialId: null, provenance: 'env_fallback' }
}

// Legacy singleton — kept temporarily; deprecate.
export function getAnthropicClient(): Anthropic { /* existing */ }
```

**Lifecycle:** one client per *run*, not per `messages.create()`. Hold the handle in run-scoped state. **Never** auto-fall-back to env on provider 401 — that hides customer's broken key behind Basics' platform key.

### 6.3 Managed-mode model selection

When `provenance='basics_managed'`, the orchestrator may rewrite the model name to whatever Basics chose for the workload. **Never** rewrite for BYOK customers.

```typescript
// api/src/lib/managed-model-routing.ts
export const MANAGED_MODELS = {
  anthropic: { agent: 'claude-sonnet-4-6', utility: 'claude-haiku-4-5' },
  openai: { agent: 'gpt-5', utility: 'gpt-5-mini' },
  gemini: { agent: 'gemini-2.5-pro', utility: 'gemini-2.5-flash' },
} as const

export function pickManagedModel(kind: string, workload: 'agent' | 'utility' | 'embed' = 'agent'): string {
  return MANAGED_MODELS[kind]?.[workload] ?? MANAGED_MODELS.anthropic.agent
}
```

### 6.4 Usage tagging (cross-cutting)

Every provider call writes `{credentialId, provenance, kind, run_id, model, input_tokens, output_tokens}` to `runtime_tool_calls` (or new `provider_usage_events`). The only way billing splits:
- `basics_managed_pooled` — internal account, Basics pays
- `basics_managed_per_workspace` — per-workspace key, Basics pays
- `customer_byok` — customer pays upstream
- `env_fallback` — alert; should not fire normally

### 6.5 Provider 401 handling

When `messages.create()` throws auth error:
1. `UPDATE workspace_credentials SET last_provider_error = 'auth_failed', last_provider_error_at = now() WHERE id = $credentialId`.
2. Fail run with user-visible error keyed off `credentialId` (desktop deep-links to credential settings).
3. **No** auto-fallback to env.

---

## 7. Managed proxy gateway (Surface A backend)

In Mode B/C, the desktop daemon doesn't call provider APIs directly. It calls the runtime gateway, which authenticates, resolves the workspace credential, and forwards to upstream.

### 7.1 Design: thin pass-through

The daemon's six provider clients already format requests correctly. The gateway is a pure auth-and-key-swap proxy. **No SDK abstraction layer on the gateway** — would just parse to re-emit.

### 7.2 Endpoints (`api/src/routes/llm-proxy.ts` — new)

```
POST /v1/llm/managed/anthropic/v1/messages
POST /v1/llm/managed/openai/v1/chat/completions
POST /v1/llm/managed/openai/v1/responses
POST /v1/llm/managed/gemini/v1beta/models/:model:generateContent
POST /v1/llm/managed/gemini/v1beta/models/:model:streamGenerateContent
```

Path mirrors upstream provider — daemon swaps base URL and works.

**Auth header rewrite per provider:**
| Provider | Daemon sends | Gateway forwards |
|----------|-------------|------------------|
| Anthropic | `Authorization: Bearer <workspace-jwt>` | `x-api-key: <plaintext>` + `anthropic-version: 2023-06-01` |
| OpenAI | `Authorization: Bearer <workspace-jwt>` | `Authorization: Bearer <plaintext>` |
| Gemini | `Authorization: Bearer <workspace-jwt>` | `?key=<plaintext>` (query param) |

### 7.3 Resolution order

Per §1 mode interaction:
1. `customer_byok` `active` → use it (tag `customer_byok`).
2. `basics_managed` `active` → use it (tag `basics_managed_per_workspace`).
3. `basics_managed` `not_provisioned` → env platform key (tag `basics_managed_pooled`).
4. None → `503 no_credential`.

### 7.4 Streaming

`c.streamSSE()` or direct body piping. Anthropic + OpenAI use SSE; Gemini uses chunked JSON. Pass through verbatim. Set `X-Accel-Buffering: no`.

### 7.5 Rate limiting

Per-workspace token bucket (e.g. 100 req/min/workspace) + per-credential limit. Prevents runaway loops eating pooled budget.

### 7.6 What it is NOT

- Not a multi-provider load balancer.
- Not a caching layer.
- Not a tool-calling abstraction (gateway sees tool defs/calls as bytes).
- Not a model validator (gating happens in daemon UI for managed mode).

---

## 8. RBAC (decided: minimal stopgap, ships with Phase 1)

No admin/member/owner split exists today. Mutating credential routes need one. M4 will refine; Phase 1 ships the minimum.

### 8.1 Migration (`api/drizzle/NNNN_workspace_member_roles.sql`)

```sql
ALTER TABLE public.workspace_members
  ADD COLUMN role text NOT NULL DEFAULT 'admin'
    CHECK (role IN ('owner', 'admin', 'member'));

UPDATE public.workspace_members wm
   SET role = 'owner'
  FROM public.workspaces w
 WHERE w.id = wm.workspace_id
   AND wm.user_id = w.created_by;
```

### 8.2 Middleware (`api/src/middleware/require-admin.ts`)

```typescript
export const requireAdmin: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const { workspace } = c.var
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspace.workspaceId),
      eq(workspaceMembers.userId, workspace.userId),
    ),
  })
  if (!member || (member.role !== 'admin' && member.role !== 'owner')) {
    return c.json({ error: 'forbidden', reason: 'admin_required' }, 403)
  }
  c.set('memberRole', member.role)
  await next()
}
```

### 8.3 M4 handoff

`role` column stays. Default `'admin'` is permissive — current users keep working. M4 changes default to `'member'` and adds invitation flow. `requireAdmin` is keepable or replaceable with M4's policy engine.

---

# Part III — Autonomous build plan

Eight self-contained phases. Each phase has explicit scope, file list, acceptance criteria, and dependencies. Each is sized to be executable as a single `/gsd-autonomous` segment.

> **Conventions for each phase:**
> - **Goal:** what it delivers in one sentence.
> - **Scope (in/out):** what to build, what to deliberately skip.
> - **Files:** explicit paths.
> - **Tasks:** numbered, atomic.
> - **Acceptance:** testable criteria — how the orchestrator knows it's done.
> - **Tests:** required test coverage.
> - **Blocked on:** prior phases or external dependencies.
> - **Complexity:** S / M / L (rough day estimate).

---

## 13.1 Phase 1 — BYOK Foundation (schema + KMS + RBAC)

**Goal:** Land the storage and crypto building blocks. No new behavior; no routes; no orchestrator changes yet.

**Scope (in):** schema migration, KMS module, RBAC migration + middleware, config updates. Pure foundation.

**Scope (out):** credentials API routes (Phase 2), orchestrator integration (Phase 3), gateway (Phase 4). Do not refactor `lib/anthropic.ts` yet.

**Files:**
- `api/drizzle/NNNN_byok_provenance_status.sql` (new) — §5.2
- `api/drizzle/NNNN_workspace_member_roles.sql` (new) — §8.1
- `api/src/db/schema-public.ts` — add columns to `workspaceCredentials`; add `role` to `workspaceMembers`
- `api/src/lib/kms.ts` (new) — §5.3
- `api/src/middleware/require-admin.ts` (new) — §8.2
- `api/src/config.ts` — add `BYOK_KMS_KEY_ALIAS`, `STAGE`, `ANTHROPIC_PLATFORM_KEY` (optional) to Zod schema
- Test files for each new module

**Tasks:**
1. Update `schema-public.ts` to match §5.1.
2. Generate migration via `pnpm drizzle-kit generate`; hand-edit to add CHECK constraints from §5.2.
3. Add RBAC migration §8.1.
4. Add config keys.
5. Create `lib/kms.ts` per §5.3 with `__resetKmsForTests()`.
6. Create `require-admin.ts` per §8.2.
7. Unit tests (see below).

**Tests required:**
- `lib/kms.test.ts` — encrypt → ciphertext + kmsKeyId; round-trip decrypt; encryption-context mismatch on decrypt rejects; missing alias throws.
- `middleware/require-admin.test.ts` — admin/owner pass; member 403; missing membership 403.
- Migration smoke test — apply both migrations to a fresh test DB, verify columns + constraints + index exist.

**Acceptance:**
- `pnpm test --filter api kms require-admin` passes.
- `pnpm drizzle-kit migrate` applies cleanly to staging Supabase.
- `psql $SUPABASE_URL -c "\d public.workspace_credentials"` shows `provenance`, `status`, `updated_at`, `last_provider_error`, `last_provider_error_at` columns and CHECK constraints.
- `psql $SUPABASE_URL -c "\d public.workspace_members"` shows `role` column.

**Blocked on:**
- BYOK CMK provisioned in staging by infra (see "Infra prereqs" §13.0). For unit tests, KMS client is mocked.

**Complexity:** M (1-2 days).

---

## 13.2 Phase 2 — Credentials CRUD API

**Goal:** The four credential routes work end-to-end against a real CMK in staging. Admins can upload, list, rotate, and clear keys. No orchestrator integration yet.

**Scope (in):** `routes/credentials.ts`, mounting in `app.ts`, request log scrubber, integration tests.

**Scope (out):** orchestrator using these credentials (Phase 3), gateway (Phase 4), workspace-create hook for `not_provisioned` rows (Phase 4), entitlement check (Phase 8).

**Files:**
- `api/src/routes/credentials.ts` (new) — §5.4
- `api/src/app.ts` — mount route + apply `requireWorkspaceJwt`
- `api/src/middleware/request-log.ts` (or wherever logging middleware lives) — drop `plaintext` from logged bodies on credential routes
- `api/src/routes/credentials.test.ts` (new)

**Tasks:**
1. Implement four endpoints per §5.4 with Zod schemas.
2. Implement workspace-mismatch check (path param vs JWT).
3. Wire request log scrubber.
4. Mount in `app.ts`.
5. Write integration tests against `freshApp()` with mocked KMS.
6. Run one manual round-trip against staging CMK.

**Tests required:**
- Each endpoint: happy path, auth failure, role failure, body validation failure, KMS failure (mocked).
- Plaintext never appears in responses.
- Plaintext never appears in logs (scrubber unit test).
- Cross-workspace path-param manipulation → 403.
- POST same `(kind, label)` while `active` → 409; after DELETE → resurrects to `active`.

**Acceptance:**
- `pnpm test --filter api credentials` passes.
- `curl -X POST $STAGING/v1/workspaces/$WS/credentials -H "Authorization: Bearer $JWT" -d '{"kind":"anthropic","plaintext":"sk-ant-test"}'` returns 201 with `CredentialMetadata`.
- Subsequent `GET` returns the row with `status='active'` and no `ciphertext` field.
- Tail Fargate logs during the POST: no plaintext appears.
- `pnpm exec rg -i 'plaintext' api/src/middleware/request-log.ts` confirms scrubber wired.

**Blocked on:** Phase 1.

**Complexity:** M (1-2 days).

---

## 13.3 Phase 3 — Cloud BYOK in orchestrator (Surface B)

**Goal:** Cloud workflows (Browserbase / computer-use) use the workspace's Anthropic credential. Mode B (Cloud BYOK) works end-to-end for Anthropic.

**Scope (in):** resolver, Anthropic refactor to per-run client, provider 401 handler, usage tagging with `{credentialId, provenance}`. Anthropic only.

**Scope (out):** Gemini/Deepgram refactor (Phase 6), gateway (Phase 4), `not_provisioned` fallback rows (Phase 4 — for now, missing row = error).

**Files:**
- `api/src/orchestrator/credential-resolver.ts` (new) — §6.1
- `api/src/lib/anthropic.ts` — refactor per §6.2; keep legacy `getAnthropicClient()` deprecated
- `api/src/orchestrator/agentLoop.ts` — replace `getAnthropicClient()` with `getAnthropicClientForWorkspace(workspaceId)`; thread `workspaceId` through `runMessages`
- `api/src/orchestrator/run.ts` — pass `workspaceId` to `agentLoop`
- `api/src/lib/managed-model-routing.ts` (new) — §6.3 (used by both Phase 3 and Phase 4)
- Wherever metering writes happen — extend with `{credentialId, provenance, model}` tag
- Tests

**Tasks:**
1. Implement resolver + `CredentialNotProvisionedError`.
2. Implement `getAnthropicClientForWorkspace`.
3. Implement model-routing table (managed-mode only).
4. Refactor `agentLoop.ts` to use per-run client; thread `workspaceId`.
5. Catch Anthropic 401 in `agentLoop.ts`; update `lastProviderError`.
6. Extend usage tagging.
7. Tests + staging integration test.

**Tests required:**
- `credential-resolver.test.ts` — active → plaintext + provenance; `not_provisioned` → throws; `cleared` → throws; `lastUsedAt` updated best-effort.
- `lib/anthropic.test.ts` — BYOK active → BYOK handle; missing + env present → env fallback; missing + no env → throws.
- `agentLoop.test.ts` — on Anthropic 401: `lastProviderError` set; run fails; **no** auto-fallback to env.
- **End-to-end staging test:** workspace with customer Anthropic key runs a workflow; verify usage shows up on customer's Anthropic console.

**Acceptance:**
- `pnpm test --filter api orchestrator` passes.
- `grep -r "getAnthropicClient(" api/src/orchestrator/` returns nothing (legacy callers all migrated).
- Staging workspace with BYOK Anthropic key runs a Browserbase workflow successfully.
- CloudTrail shows decrypt event with encryption context `purpose=workspace_credential`.
- Customer's Anthropic dashboard shows the usage from that staging run.

**Blocked on:** Phase 1, Phase 2.

**Complexity:** L (2-3 days — touches the hot path).

---

## 13.4 Phase 4 — Managed proxy gateway + provisioning (Surface A backend)

**Goal:** Daemon in `managed` mode has a working endpoint. Managed-mode workspaces work without admin intervention. Mode C end-to-end.

**Scope (in):** `routes/llm-proxy.ts`, workspace-create hook seeding `not_provisioned` rows, resolver fallback for managed, rate limiting, streaming pass-through.

**Scope (out):** desktop changes (Phase 5), Gemini/Deepgram orchestrator refactor (Phase 6), assistant API key auth flow (Phase 6 if needed).

**Files:**
- `api/src/routes/llm-proxy.ts` (new) — §7
- `api/src/app.ts` — mount routes
- Wherever workspace insert happens — add managed-row seeding
- `api/src/orchestrator/credential-resolver.ts` — extend with §7.3 fallback order; add `provenance='basics_managed_pooled'` return value
- `api/src/middleware/rate-limit.ts` (new or extend existing) — token bucket
- `api/src/routes/llm-proxy.test.ts` (new)

**Tasks:**
1. Implement Anthropic + OpenAI + Gemini proxy routes per §7.2.
2. Auth-header swap per provider table.
3. Streaming pass-through (no buffering).
4. Workspace-create hook: insert `basics_managed` `not_provisioned` rows for `anthropic`, `openai`, `gemini`.
5. Extend resolver with §7.3 fallback order.
6. Rate limit middleware + per-workspace + per-credential limits.
7. Usage tagging from upstream response (`usage` field).
8. Tests + staging integration.

**Tests required:**
- Per provider: auth swap correct; streaming chunks pass through; cross-workspace 403; rate limit triggers.
- Resolver: managed → BYOK preference order from §1.
- Workspace-create hook: new workspace gets three `not_provisioned` rows.
- **End-to-end staging test:** daemon configured with `services.inference.mode: "managed"`, `LLM_BASE_URL=https://staging-runtime/v1/llm/managed/anthropic` → daemon's normal Anthropic call returns a streamed response.
- **BYOK upgrade test:** managed-mode workspace adds Anthropic BYOK; next gateway request goes to BYOK key (verified via customer Anthropic console).

**Acceptance:**
- `pnpm test --filter api llm-proxy` passes.
- Daemon-as-client integration test passes against staging.
- Streaming response not buffered (verify chunk arrival times).
- Metering dashboard splits `basics_managed_pooled` vs `basics_managed_per_workspace` vs `customer_byok` token spend.
- Synthetic burst test triggers rate limit.

**Blocked on:** Phase 1, Phase 2, Phase 3.

**Complexity:** L (3-4 days — three providers + streaming + metering).

---

## 13.5 Phase 5 — Desktop integration (in `basics-assistant`)

**Goal:** `basics-assistant` consumes the credentials API and the managed-proxy gateway. UI respects roles and modes.

**Scope (in):** desktop changes only — IPC contract doc, workspace-switch credential fetch, run picker, `resolveManagedProxyContext` swap, save-BYOK flow, member hide, provider-error surfacing.

**Scope (out):** runtime changes; Phase 6+ provider work.

**Repo:** `~/Developer/basics-assistant` (not `~/Developer/basics`).

**Files:**
- `basics-assistant/docs/RUNTIME-IPC.md` (new) — pin gateway URLs, header contract, cache shape
- `basics-assistant/assistant/src/providers/registry.ts` — update `resolveManagedProxyContext()` to return runtime gateway base URLs (`/v1/llm/managed/<provider>`) with workspace JWT
- `basics-assistant/assistant/src/runtime/credentials/` (new dir) — workspace-switch fetcher + cache + types
- Run picker / settings UI components — surface `provenance` + `status`; grey out unavailable; managed-mode model picker constraint
- Save-BYOK modal — confirm → POST → invalidate cache
- Member-role detection — hide credentials panel on 403
- Tests

**Tasks:**
1. Write IPC contract doc.
2. Update `resolveManagedProxyContext()`.
3. Implement credential metadata fetcher with on-workspace-switch trigger.
4. Update run picker to read cache.
5. Implement save-BYOK modal.
6. Hide credentials panel on 403.
7. Surface `last_provider_error` deep-link to settings.
8. Hide / restrict model picker in managed mode (per §2 Q9 recommendation: curated list).
9. Tests + manual end-to-end.

**Tests required:**
- Workspace switch invalidates and refetches cache.
- Local mode (`your-own`) makes zero `GET /credentials` calls.
- Member role: panel hidden.
- Save-BYOK requires explicit confirmation.
- Daemon in managed mode end-to-end via runtime gateway.

**Acceptance:**
- Daemon configured with workspace JWT successfully runs a managed-mode chat through the runtime gateway end-to-end.
- Switching workspaces refreshes credential availability without manual refresh.
- 403 on credentials = panel hidden, generic affordance shown.
- Run picker greys out `not_provisioned` providers correctly.

**Blocked on:** Phase 1, Phase 2, Phase 3, Phase 4.

**Complexity:** L (3-4 days — UI + IPC + state management).

---

## 13.6 Phase 6 — Multi-provider depth (Gemini + Deepgram + OpenAI)

**Goal:** Cloud-side providers beyond Anthropic support BYOK. The runtime's own Gemini calls (`routes/llm.ts`) and Deepgram calls (`voice.ts`) use workspace credentials.

**Scope (in):** Gemini orchestrator refactor (mirrors §6.2), Deepgram refactor (already per-request — just resolve workspace key), OpenAI provider integration if/when needed.

**Scope (out):** new model providers beyond the catalog; override-mode routing (Phase 7).

**Files:**
- `api/src/routes/llm.ts` — replace `_genai` singleton with `getGeminiClientForWorkspace()`
- `api/src/lib/gemini.ts` (new, mirroring `lib/anthropic.ts` pattern)
- `api/src/lib/deepgram.ts` — accept workspaceId; resolve workspace key; fall back to env
- `api/src/routes/voice.ts` — pass `workspaceId` to `grantDeepgramToken`
- `api/src/lib/openai.ts` (new — only if OpenAI integration is being added in this phase)
- Tests

**Tasks:**
1. Mirror Anthropic refactor for Gemini.
2. Refactor Deepgram to resolve workspace key.
3. (Optional) Add OpenAI provider with same per-request pattern from day one.
4. Tests.

**Tests required:**
- Per provider refactor: BYOK active → BYOK handle; missing + env → fallback; missing + no env → throws.
- Provider 401 handling per §6.5.

**Acceptance:**
- `pnpm test --filter api gemini deepgram` passes.
- Customer's Gemini account shows usage from a staging `/v1/llm` call when their Gemini BYOK key is configured.
- Customer's Deepgram account shows usage from a staging voice session.

**Blocked on:** Phase 3.

**Complexity:** M (1-2 days per provider — pattern is established).

---

## 13.7 Phase 7 — Admin UX & polish

**Goal:** Production-quality admin surface. Rotation, audit, "require BYOK" workspace policy, optional override-mode model routing.

**Scope (in):** UI affordances on top of the API; "require BYOK" policy enforcement; audit log viewer; multi-label support if shipping.

**Scope (out):** monetization gating (Phase 8); new providers (Phase 6).

**Files:**
- Desktop admin panel — rotation modal, audit log, "require BYOK" toggle
- `api/src/routes/credentials.ts` — extend `GET` with `?include=usage_events` if needed
- `api/src/routes/byok-events.ts` (new, or extend existing metering endpoint) — paginated audit feed
- `api/src/lib/managed-model-routing.ts` — wire `X-Basics-Workload` header → override mode (if shipping)
- "Require BYOK" workspace setting — new `workspaces.require_byok` column or settings JSON; resolver honors

**Tasks:**
1. Rotation UI: "Replace key" → `PATCH /credentials/:id`.
2. Audit log viewer reading `byok_usage_events` (or equivalent).
3. "Require BYOK" workspace policy: when on, pooled fallback disabled; runs fail loud if BYOK missing.
4. Multi-label UI if shipping (per §15 Q4).
5. Optional: override-mode model routing per §6.3 if cost data justifies.

**Tests required:**
- Rotation: `PATCH` updates `rotatedAt`; next run uses new key (verify via staging).
- "Require BYOK" on + BYOK missing → run fails with explicit error, not env fallback.
- Audit log returns paginated decrypt events.

**Acceptance:**
- Admin can rotate without downtime.
- Audit log shows decrypts with run IDs + timestamps.
- Workspace with `require_byok=true` cannot run when BYOK is `cleared`.

**Blocked on:** Phase 2, Phase 3, Phase 4, Phase 5.

**Complexity:** M (2-3 days).

---

## 13.8 Phase 8 — Monetization gating

**Goal:** Runtime enforces "BYOK requires Team+ plan" so the monetization model in §2 actually holds.

**Scope (in):** plan-tier check on credential creation, plan claim in workspace JWT (or DB lookup), "upgrade required" error response shape.

**Scope (out):** Stripe integration, plan upgrade flows, pricing-page UI, dunning, billing service. Those live in the billing system; this plan delivers only the runtime enforcement glue.

**Files:**
- `api/src/middleware/require-byok-entitlement.ts` (new)
- `api/src/routes/credentials.ts` — apply `requireBYOKEntitlement` to `POST` when `provenance='customer_byok'`
- `api/src/db/schema-public.ts` — add `plan` column to `workspaces` if not already present (e.g., `'free' | 'pro' | 'team' | 'enterprise'`)
- Workspace JWT — include `plan` claim (or read from DB on each call — pick based on freshness needs)
- Tests

**Tasks:**
1. Decide plan-claim strategy: JWT claim (fast, must refresh on plan change) vs DB lookup per request (slower, always fresh). Recommend JWT claim with short TTL.
2. Implement `requireBYOKEntitlement` middleware: 402 `payment_required` with `{ error, upgrade_url }` if plan is `free` or `pro` and request is BYOK.
3. Wire into `POST /credentials` route only when `provenance='customer_byok'`. `basics_managed` row creation is unaffected.
4. Tests.

**Tests required:**
- Free / Pro plan + `provenance='customer_byok'` POST → 402.
- Team / Enterprise plan + `provenance='customer_byok'` POST → 201.
- Any plan + `provenance='basics_managed'` POST → 201 (Basics seeds these regardless of customer plan).

**Acceptance:**
- Staging workspace on `pro` plan: BYOK POST → 402 with `upgrade_url`.
- Same workspace on `team` plan: BYOK POST → 201.
- Existing managed-mode functionality unchanged.

**Blocked on:** Phase 2; **billing system delivers `plan` field** (could be a hardcoded `'team'` for testing if billing isn't ready).

**Complexity:** S (1 day for the runtime side; billing integration scope is separate).

---

## 13.0 Infra prereqs (parallel; not a phase)

These need infra/SecOps engagement and run in parallel with Phase 1:

1. Provision CMK `alias/basics-byok-${stage}` per stage with key policy allowing the Fargate task role to `Encrypt`/`Decrypt` with `purpose=workspace_credential` encryption context.
2. Attach IAM policy from §5.5 to the Fargate task role.
3. Enable CloudTrail data events on the BYOK CMK.
4. Decide CloudTrail destination — central security account or runtime account (§15 Q7).

---

## 13.9 Phase dependency graph

```
Phase 0 (infra) ─┬─→ Phase 1 ─→ Phase 2 ─┬─→ Phase 3 ─┬─→ Phase 4 ─→ Phase 5 ─→ Phase 7
                 │                       │            │
                 │                       │            ├─→ Phase 6 (parallel with 4)
                 │                       │            │
                 │                       └────────────┴─→ Phase 8 (parallel after Phase 2)
```

**Critical path:** Infra → 1 → 2 → 3 → 4 → 5 → 7. Phases 6 and 8 can run in parallel after their respective unblocks.

---

# Part IV — Test plan, security, open questions

## 14. Test plan (cross-phase summary)

### 14.1 Unit (Vitest, colocated)

Per phase test files cover their own modules. Cross-phase verification:
- KMS round-trip with encryption context.
- Resolver branches (active / not_provisioned / cleared / missing).
- Anthropic handle resolution branches.
- Provider 401 → `lastProviderError` set, no env fallback.
- Gateway auth swap per provider; streaming passthrough; rate limit triggers.
- Plan-tier gating on POST.

### 14.2 Integration (against staging Supabase + real CMK)

1. POST → row appears with `status='active'`, ciphertext non-null, no plaintext in logs.
2. GET → metadata only.
3. Orchestrator run consumes credential; CloudTrail shows decrypt; `lastUsedAt` advances.
4. DELETE → row persists with `status='cleared'`, `ciphertext=NULL`.
5. POST same `(kind, label)` after DELETE → resurrects.
6. POST same `(kind, label)` while `active` → 409.
7. Cross-workspace: workspace A's JWT cannot read workspace B's credentials → 403.
8. **End-to-end Cloud BYOK proof (Phase 3):** customer's Anthropic console shows usage from a staging workflow.
9. **End-to-end managed-proxy proof (Phase 4):** daemon in managed mode hits gateway → upstream Anthropic → daemon receives streamed response identical to direct API.
10. **BYOK upgrade in managed mode:** managed workspace adds BYOK; next gateway request goes to BYOK key.
11. Provider 401 simulation: revoke a BYOK key upstream → `lastProviderError` set, run fails loud, no env fallback.
12. Plan-tier gating: free workspace POST BYOK → 402.

### 14.3 Security checks (blocking for merge)

- `pnpm exec rg -i 'plaintext|api[_-]?key' api/src/middleware/request-log.ts` confirms scrubber wired.
- `pnpm exec rg 'console.log.*ciphertext|console.log.*plaintext' api/src` returns nothing.
- `pnpm exec rg 'JSON.stringify.*client' api/src/orchestrator` returns nothing.
- Manual: 403 verification on member-role JWT.
- Manual: Fargate logs during POST contain no plaintext or ciphertext.

### 14.4 Load (post-Phase 4, before public launch)

- 50 concurrent gateway requests against one workspace → KMS Decrypt rate stays under account limit. Add LRU if close.
- 100 concurrent runs across 10 workspaces → no cross-workspace credential leakage.

---

## 15. Security & compliance (minimum bar)

- TLS for all plaintext-in-transit.
- KMS encryption at rest; encryption context bound.
- CloudTrail data events on the CMK; append-only `byok_usage_events`.
- Document data residency (us-east-1 today) and key access (Fargate task role + named human break-glass) for SOC2.
- CODEOWNERS on `api/src/lib/kms.ts`, `api/src/lib/anthropic.ts`, `api/src/routes/credentials.ts`, `api/src/routes/llm-proxy.ts`, `api/src/orchestrator/credential-resolver.ts` — security reviewer required.

---

## 16. Open questions

1. **Per-workspace vs pooled Basics keys** (blocks Phase 4 path choice). Pooled is simpler for v1.
2. ~~Identity for local context~~ Resolved §3 + §6.5: `X-Basics-Context` header.
3. ~~Invitees and BYOK metadata visibility~~ Resolved: admin-only, 403 for members.
4. **Multi-key labels in v1?** Schema supports `(workspace_id, kind, label)`. Recommend defer UI to Phase 7; default label `''`.
5. **Rotation contract** — recommend PATCH-only.
6. ~~RBAC path~~ Resolved §8: minimal `workspace_members.role` ships with Phase 1.
7. **CloudTrail destination** — central security account or runtime account? (Owner: SecOps; needed before infra prereqs.)
8. **`ANTHROPIC_API_KEY` deprecation** — once Phase 3 lands, when do we delete the legacy env-singleton path? Recommend: hold for one stage cycle after Phase 4 ships pooled fallback.
9. **Managed-mode model picker UX** — when daemon is in managed mode, do we hide the picker, show curated list, or show all with warning? Recommend curated list. (Resolves in Phase 5 design.)
10. **Assistant API key vs JWT for daemon → gateway auth** — does `resolveManagedProxyContext()` already issue an `assistantApiKey` today, and how is it minted? Verify before Phase 4 or formalize in Phase 6.
11. **Plan-claim strategy** — JWT claim (fast, requires refresh) vs per-request DB lookup (slower, always fresh). Recommend JWT claim with short TTL. Resolves in Phase 8 design.

---

## 17. Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Control plane | | | |
| Orchestrator | | | |
| Desktop | | | |
| Infra (KMS/IAM) | | | |
| Billing (Phase 8 only) | | | |

---

## 18. Changelog

- **2026-05-08** — Initial draft.
- **2026-05-08** — Desktop-side audit pass: pinned local storage; resolved schema open questions; added context-signaling header; closed §16 Q2.
- **2026-05-08** — Closed §16 Q3: admin-only credential metadata.
- **2026-05-08** — Detailed-implementation rewrite anchored to existing stack; added schema migration SQL, KMS module + IAM, CRUD API + Zod schemas, RBAC stopgap, resolver code, per-phase task lists with file paths, test plan.
- **2026-05-08** — Locked RBAC to minimal stopgap. Added Provider integration: Anthropic singleton refactor (critical path), Gemini deferred, Deepgram already-compatible. Added `lastProviderError` columns + 401 handling rules + usage-tagging contract.
- **2026-05-08** — Major restructure after `basics-assistant` survey: discovered local key storage is `~/.vellum/protected/keys.enc` not Keychain; `services.inference.mode` and `resolveProviderCredentials()` already exist; desktop never proxies through runtime today. Added two-call-surface architecture, corrected local-storage rule, added managed proxy gateway (thin pass-through, opinionated routing, BYOK upgrade-in-place), added managed-mode model selection (Basics chooses model only for `basics_managed`, never overrides BYOK).
- **2026-05-08** — **Restructure for autonomous execution.** Three customer modes (Local BYOK / Cloud BYOK / Managed) hoisted to §1 as the product surface. Added §2 monetization model (price discrimination — gate BYOK to Team+ plan; default new signups to Managed; don't kill BYOK because compliance customers walk). Restructured into Part I (product framing), Part II (architecture & components), Part III (eight self-contained build phases each runnable as a `/gsd-autonomous` segment with explicit scope/files/acceptance/blocked-on/complexity), Part IV (cross-phase test plan + security + open questions). Added Phase 8 (monetization gating — runtime enforcement only; Stripe integration is billing's scope). Added §13.0 (infra prereqs running parallel with Phase 1) and §13.9 (phase dependency graph). Added §16 Q11 (plan-claim strategy).

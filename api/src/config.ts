import { z } from 'zod'

/**
 * Runtime API env schema.
 *
 * Required for boot:
 *  - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET (auth)
 *  - WORKSPACE_JWT_SECRET (HS256 secret for workspace JWTs; min 8 to allow dev defaults)
 *  - GEMINI_API_KEY (LLM streaming proxy)
 *
 * Optional (capability-gated — endpoints return 503 if unset rather than crashing on boot):
 *  - DATABASE_URL, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, BROWSERBASE_*
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // === Supabase ===
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // === Workspace JWT (issued by /v1/auth/token, verified by requireWorkspaceJwt) ===
  WORKSPACE_JWT_SECRET: z.string().min(8),

  // === LLM ===
  GEMINI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // === Voice ===
  DEEPGRAM_API_KEY: z.string().optional(),

  // === Browserbase (future runtime work) ===
  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),

  // === Database ===
  /** Railway / some Doppler configs expose Postgres as DB_URL only */
  DB_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  // === EventBridge cron firing (Phase 10.5) ===
  // Shared secret presented by EventBridge in the X-Cron-Secret header
  // when the API destination invokes /v1/runtime/workflows/:id/run-now.
  // Optional in dev/test (lifecycle hooks become no-ops without
  // EVENTBRIDGE_RULE_PREFIX); required in production for the route to
  // accept cron-triggered calls. Min length 16 to discourage trivially
  // guessable values.
  RUNTIME_CRON_SECRET: z.string().min(16).optional(),
  // Prefix used when naming per-workflow EventBridge rules. Acts as the
  // master toggle for the rule-management module: when unset, lifecycle
  // hooks are no-ops so dev / tests never call AWS. Set in SST's
  // environment block once the EventBridge connection + API destination
  // are wired.
  //
  // The next two ARNs come from SST's apiService.environment block, which
  // sets `process.env.EVENTBRIDGE_*_ARN ?? ""` — so we get an empty
  // string in the container when the deployer hasn't exported the ARN
  // locally (chicken-and-egg: the ARNs are produced by the same SST
  // run that deploys the app). Treat "" the same as missing so the
  // container boots cleanly; the runtime-rule helpers separately guard
  // on the prefix being set before they call AWS.
  EVENTBRIDGE_RULE_PREFIX: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  EVENTBRIDGE_API_DESTINATION_ARN: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  EVENTBRIDGE_TARGET_ROLE_ARN: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),

  // === Server ===
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  BASICS_ALLOWED_ORIGINS: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  /** S3 bucket for routine artifacts (Basics Cloud M1/M2). */
  ARTIFACTS_S3_BUCKET: z.string().optional(),

  // === BYOK / KMS (optional until credentials routes are used) ===
  /** AWS KMS key alias for workspace credential ciphertext, e.g. alias/basics-byok-prod */
  BYOK_KMS_KEY_ALIAS: z.string().min(1).optional(),
  /** Deploy stage label (dev/staging/prod) — used for observability defaults */
  STAGE: z.string().optional(),
  /** Basics pooled Anthropic key for managed fallback (preferred over ANTHROPIC_API_KEY when set) */
  ANTHROPIC_PLATFORM_KEY: z.string().optional(),
  /** Shown in 402 responses when BYOK POST is blocked on lower tiers */
  BYOK_UPGRADE_URL: z.string().url().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Env {
  const merged = { ...source }
  const db = merged.DATABASE_URL?.trim()
  const alt = merged.DB_URL?.trim()
  if ((!db || db.length === 0) && alt && alt.length > 0) {
    merged.DATABASE_URL = alt
  }
  const parsed = EnvSchema.safeParse(merged)
  if (!parsed.success) {
    const errors = parsed.error.flatten()
    // eslint-disable-next-line no-console
    console.error('Invalid environment variables:', JSON.stringify(errors, null, 2))
    throw new Error('Invalid environment variables')
  }
  return parsed.data
}

// Lazy singleton — tests can override process.env before first access.
let _config: Env | null = null
export function getConfig(): Env {
  if (!_config) _config = loadConfig()
  return _config
}

// Test-only: reset cached config so subsequent getConfig() re-reads process.env.
export function __resetConfigForTests(): void {
  _config = null
}

/**
 * Proxy-backed export so callers can `import { config }` without forcing
 * `loadConfig()` at import time. Tests can mutate process.env first.
 *
 * `has`, `ownKeys`, `getOwnPropertyDescriptor` are wired so spread / Object.keys /
 * JSON.stringify behave like a real object.
 */
export const config: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    return getConfig()[prop as keyof Env]
  },
  has(_t, prop: string) {
    return prop in getConfig()
  },
  ownKeys() {
    return Reflect.ownKeys(getConfig())
  },
  getOwnPropertyDescriptor(_t, prop: string) {
    return { enumerable: true, configurable: true, value: getConfig()[prop as keyof Env] }
  },
})

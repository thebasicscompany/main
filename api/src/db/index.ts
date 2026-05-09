import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getConfig } from '../config.js'
import { DatabaseUnavailableError } from '../lib/errors.js'
import { tlsOptsForPostgresUrl } from '../lib/postgres-supabase-tls.js'
import * as schemaPublic from './schema-public.js'
import * as schemaRuntime from './schema.js'

const schema = { ...schemaRuntime, ...schemaPublic }

/**
 * Postgres-js client for the runtime API.
 *
 * Pool size 5 for ECS, 1 for Lambda (Supavisor multiplexes onto ~10 backend
 * connections regardless, so per-Lambda pool doesn't help). `prepare: false`
 * is required by Supabase's transaction-mode pooler (port 6543).
 *
 * URL preference, from §13.2:
 *   - Lambda runtime → DATABASE_URL_POOLER (Supavisor) if set
 *   - Anywhere else → DATABASE_URL (direct)
 *   - Caller-passed `url` always wins (tests, scripts).
 */
function isLambdaRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME)
}

export function createQueryClient(url?: string) {
  const cfg = getConfig()
  const databaseUrl =
    url ?? (isLambdaRuntime() ? (cfg.DATABASE_URL_POOLER ?? cfg.DATABASE_URL) : cfg.DATABASE_URL)
  if (!databaseUrl) {
    throw new DatabaseUnavailableError()
  }
  return postgres(databaseUrl, {
    max: isLambdaRuntime() ? 1 : 5,
    prepare: false,
    ...tlsOptsForPostgresUrl(databaseUrl),
  })
}

// Lazy singleton — importing this module does not open a socket.
let _client: ReturnType<typeof postgres> | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

/**
 * Returns the Drizzle binding for the runtime DB. Throws
 * `DatabaseUnavailableError` if `DATABASE_URL` is unset so the caller
 * (a route handler) can return 503.
 */
export function getDb() {
  if (!_db) {
    _client = createQueryClient()
    _db = drizzle(_client, { schema })
  }
  return _db
}

/**
 * Proxy so callers can `import { db }` and still defer socket creation
 * until first actual use. Unlocks easy mocking in tests.
 */
export const db: ReturnType<typeof getDb> = new Proxy({} as ReturnType<typeof getDb>, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>
    const value = real[prop]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value
  },
})

export { schema }

// Test-only: tear down the cached client/db so a new env can be used.
export async function __resetDbForTests(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 1 }).catch(() => {})
  }
  _client = null
  _db = null
}

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
 * Pool size 5 (matches the legacy api: ECS container fans out to one
 * postgres-js pool per process; 5 keeps total connections bounded under
 * autoscale). `prepare: false` defensively avoids breakage if Supabase's
 * transaction pooler (port 6543) ever fronts the runtime DB.
 */
export function createQueryClient(url?: string) {
  const databaseUrl = url ?? getConfig().DATABASE_URL
  if (!databaseUrl) {
    throw new DatabaseUnavailableError()
  }
  return postgres(databaseUrl, {
    max: 5,
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

/**
 * Apply Drizzle migrations using drizzle-orm migrator (postgres-js).
 *
 * Supabase **transaction pooler (:6543)** breaks Drizzle advisory locks and should not
 * be used for migrations. Same-host **session pooler (:5432)** can still reject logins
 * (`tenant/user not found`). Prefer the **direct** URI:
 *   postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
 *
 * Resolution order for the raw URL:
 *   1. `SUPABASE_DIRECT_DATABASE_URL` (optional explicit direct URI)
 *   2. `SUPABASE_MIGRATION_URL`, `MIGRATION_URL`, … then env DB URLs
 * Then rewrite (see `scripts/lib/supabase-migrate-url.ts`).
 *
 * Prefer this script over `drizzle-kit migrate`; both now share the same URL logic.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { tlsOptsForPostgresUrl } from '../src/lib/postgres-supabase-tls.js'
import { resolveMigrateConnectionUrl } from './lib/supabase-migrate-url.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const url = resolveMigrateConnectionUrl()
const sql = postgres(url, { max: 1, ...tlsOptsForPostgresUrl(url) })
const db = drizzle(sql)

try {
  await migrate(db, {
    migrationsFolder: path.join(__dirname, '../drizzle'),
    migrationsSchema: 'runtime',
    migrationsTable: '__drizzle_migrations',
  })
  console.log('db-migrate: complete')
} finally {
  await sql.end({ timeout: 10 })
}

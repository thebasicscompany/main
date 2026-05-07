import { defineConfig } from 'drizzle-kit'

// drizzle-kit is a CLI — reads env vars directly (no zod wrapper).
// Prefer SUPABASE_MIGRATION_URL (session pooler / direct, 5432) because
// drizzle-kit uses advisory locks + multi-statement DDL the transaction
// pooler (6543) rejects. Fall back to SUPABASE_DATABASE_URL for local/dev
// where only one URL is configured. Legacy MIGRATION_URL/DATABASE_URL are
// still honored so existing dev setups don't break.
const url =
  process.env.SUPABASE_MIGRATION_URL ??
  process.env.MIGRATION_URL ??
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL
if (!url) {
  throw new Error(
    'SUPABASE_MIGRATION_URL (or SUPABASE_DATABASE_URL) must be set when running drizzle-kit commands',
  )
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  // Only manage the runtime namespace — agent/'s public.* tables are off-limits.
  schemaFilter: ['runtime'],
  // CRITICAL: place our migration tracker inside `runtime` so it doesn't
  // collide with agent/'s `drizzle.__drizzle_migrations`.
  migrations: {
    schema: 'runtime',
    table: '__drizzle_migrations',
  },
  strict: true,
  verbose: true,
})

/**
 * One-off introspection against the migrate URL (same as db:migrate).
 * Run: doppler run --project backend --config dev -- pnpm exec tsx scripts/db-introspect.ts
 */
import postgres from 'postgres'
import { resolveMigrateConnectionUrl } from './lib/supabase-migrate-url.js'
import { tlsOptsForPostgresUrl } from '../src/lib/postgres-supabase-tls.js'

const url = resolveMigrateConnectionUrl()
const sql = postgres(url, { max: 1, ...tlsOptsForPostgresUrl(url) })

try {
  const tables = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema IN ('runtime', 'public', 'drizzle')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name`
  const host = new URL(url.replace(/^postgres:/i, 'postgresql:')).hostname
  const hostKind = host.includes('pooler.') ? 'pooler' : host.startsWith('db.') ? 'direct' : 'custom'
  console.log(JSON.stringify({ hostKind, tables }, null, 2))

  const mj = await sql`SELECT COUNT(*)::int AS n FROM runtime.__drizzle_migrations`.catch(() => [{ n: null }])
  console.log('\nruntime.__drizzle_migrations:', mj[0])

  const wc = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_credentials'
    ORDER BY ordinal_position`
  console.log('\npublic.workspace_credentials columns:', wc.length ? wc : '(no table)')
} finally {
  await sql.end({ timeout: 5 })
}

/**
 * Shared URL normalization for Drizzle migrations against Supabase (pooler vs direct).
 * Used by `scripts/db-migrate.ts` and `drizzle.config.ts` (drizzle-kit migrate).
 */

/**
 * Map Supavisor pooler connection string to Supabase **direct** Postgres host.
 * Username must be `postgres.<project-ref>` (dashboard “pooler” URI shape).
 */
export function transactionPoolerToDirectDb(urlStr: string): string | null {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    try {
      u = new URL(urlStr.replace(/^postgres:\/\//i, 'postgresql://'))
    } catch {
      return null
    }
  }
  if (!u.hostname.endsWith('pooler.supabase.com')) return null
  const port = u.port === '' ? '5432' : u.port
  if (port !== '6543' && port !== '5432') return null

  let userDecoded: string
  try {
    userDecoded = decodeURIComponent(u.username)
  } catch {
    return null
  }
  const um = userDecoded.match(/^postgres\.([^:]+)$/)
  if (!um) return null
  const ref = um[1]

  const out = new URL('postgresql://postgres@placeholder/postgres')
  out.hostname = `db.${ref}.supabase.co`
  out.port = '5432'
  out.pathname = u.pathname && u.pathname !== '/' ? u.pathname : '/postgres'
  out.username = 'postgres'
  out.password = u.password
  out.search = u.search
  const ssl = out.searchParams.get('sslmode')
  if (!ssl || ssl === 'disable') {
    out.searchParams.set('sslmode', 'require')
  }

  console.log(
    `migrate-url: Supabase pooler → direct db.${ref}.supabase.co:5432 (sslmode=${out.searchParams.get('sslmode') ?? 'require'})`,
  )
  return out.toString()
}

/** Last resort: transaction pooler **6543 → 5432** on the same pooler hostname. */
export function upgradeSupabasePoolerForMigrate(urlStr: string): string {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    return urlStr
  }
  if (!u.hostname.endsWith('pooler.supabase.com')) return urlStr
  if (u.port !== '6543') return urlStr
  u.port = '5432'
  if (!u.searchParams.get('sslmode')) {
    u.searchParams.set('sslmode', 'require')
  }
  console.log('migrate-url: Supabase pooler 6543 → 5432 (session) + sslmode=require')
  return u.toString()
}

export function rawMigrateUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return (
    env.SUPABASE_DIRECT_DATABASE_URL?.trim() ||
    env.SUPABASE_MIGRATION_URL?.trim() ||
    env.MIGRATION_URL?.trim() ||
    env.SUPABASE_DATABASE_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    env.DB_URL?.trim() ||
    ''
  )
}

export function resolveMigrateConnectionUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = rawMigrateUrlFromEnv(env)
  if (!raw) {
    throw new Error(
      'Set SUPABASE_DIRECT_DATABASE_URL, SUPABASE_MIGRATION_URL, MIGRATION_URL, SUPABASE_DATABASE_URL, DATABASE_URL, or DB_URL',
    )
  }
  return transactionPoolerToDirectDb(raw) ?? upgradeSupabasePoolerForMigrate(raw)
}

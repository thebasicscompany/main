/**
 * postgres-js TLS for Supabase: mirrors typical direct/pg setups using
 * `ssl: { rejectUnauthorized: false }` where strict verification fails in dev.
 *
 * Set `DATABASE_SSL_REJECT_UNAUTHORIZED=true` to omit overrides (TLS defaults).
 */

export function tlsOptsForPostgresUrl(
  connectionUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { ssl?: { rejectUnauthorized: boolean } } {
  if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true') {
    return {}
  }

  let host = ''
  try {
    host = new URL(connectionUrl.replace(/^postgres:/i, 'postgresql:')).hostname
  } catch {
    return {}
  }

  if (!host.endsWith('.supabase.co') && !host.endsWith('pooler.supabase.com')) {
    return {}
  }

  return { ssl: { rejectUnauthorized: false } }
}

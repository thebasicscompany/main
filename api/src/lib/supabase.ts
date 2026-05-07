import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getConfig } from '../config.js'
import { requireEnv } from './errors.js'

/**
 * Service-role Supabase client. Bypasses RLS — use ONLY from trusted server
 * code. Never expose this to browsers.
 */
let _admin: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin
  const env = getConfig()
  const url = requireEnv('SUPABASE_URL', env.SUPABASE_URL)
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY)
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

/**
 * Create a Supabase client scoped to an end-user's access token.
 * All queries run under that user's RLS policies.
 */
export function supabaseClient(accessToken: string): SupabaseClient {
  if (!accessToken || accessToken.trim().length === 0) {
    throw new Error('supabaseClient: accessToken is required')
  }
  const env = getConfig()
  const url = requireEnv('SUPABASE_URL', env.SUPABASE_URL)
  const anonKey = requireEnv('SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY)
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  })
}

// Test-only: reset the cached admin client so a new config takes effect.
export function __resetSupabaseForTests(): void {
  _admin = null
}

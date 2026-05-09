import { defineConfig } from 'drizzle-kit'
import { resolveMigrateConnectionUrl } from './scripts/lib/supabase-migrate-url.js'

// drizzle-kit is a CLI — reads env vars directly (no zod wrapper).
// Uses the same Supabase pooler → direct host rewrite as `pnpm db:migrate`
// (see scripts/lib/supabase-migrate-url.ts). Prefer `pnpm db:migrate` for CI;
// drizzle-kit migrate should behave equivalently when given the same env.
const url = resolveMigrateConnectionUrl()

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/schema-public.ts'],
  out: './drizzle',
  dbCredentials: { url },
  // `runtime.*` + our narrow `public.workspace_*` tables only — not agent/'s full public schema.
  schemaFilter: ['runtime', 'public'],
  // CRITICAL: place our migration tracker inside `runtime` so it doesn't
  // collide with agent/'s `drizzle.__drizzle_migrations`.
  migrations: {
    schema: 'runtime',
    table: '__drizzle_migrations',
  },
  strict: true,
  verbose: true,
})

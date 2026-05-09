#!/usr/bin/env node
/**
 * Phase 11 — launch-template seeder.
 *
 * Inserts (or upserts) the five hand-built workflow templates into
 * `runtime.runtime_workflows` for a target workspace. Idempotent by
 * `(workspace_id, name)`: re-running the script overwrites the existing
 * rows in place rather than creating duplicates.
 *
 * Usage:
 *   doppler run --project backend --config dev -- sh -c 'DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @basics/api seed:templates'
 *
 * Env:
 *   DATABASE_URL          — required. The runtime DB Postgres URL.
 *   SEED_WORKSPACE_ID     — optional. Default: the test workspace from
 *                            HANDOFF.md (139e7cdc-7060-49c8-a04f-2afffddbd708).
 *   SEED_DISABLE_OUTPUT   — optional. Set to "1" to suppress info logs
 *                            (the script still writes; only stdout is quiet).
 *
 * Why no `runtime_workflows` unique index on (workspace_id, name)?
 *   The Phase 10 schema lets a workspace have two workflows with the
 *   same display name (it's a UI label, not a slug). The seeder enforces
 *   uniqueness only for ITS OWN rows by reading-then-writing. Hand-created
 *   workflow rows with the same name as a template will be left alone
 *   (the seeder overwrites the row whose `id` it most recently inserted —
 *   but since we don't track id-of-last-insert, we look up by name and
 *   pick the first match).  See `findExistingByName` for the contract.
 *
 * Reversibility:
 *   To undo a seed: DELETE FROM runtime.runtime_workflows
 *                   WHERE workspace_id = '<id>' AND name IN (<5 names>);
 *   The script logs the names + ids it touched so the operator can build
 *   the DELETE manually.
 */

import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { tlsOptsForPostgresUrl } from '../src/lib/postgres-supabase-tls.js'
import { workflows as workflowsTable } from '../src/db/schema.js'
import { ALL_TEMPLATES, type WorkflowTemplate } from './templates/index.js'

const DEFAULT_WORKSPACE_ID = '139e7cdc-7060-49c8-a04f-2afffddbd708'

interface SeedResult {
  name: string
  id: string
  action: 'inserted' | 'updated'
}

function log(msg: string): void {
  if (process.env.SEED_DISABLE_OUTPUT === '1') return
  // The seeder is a CLI; stdout is the user-facing surface. Going through
  // pino here would add JSON noise + dependency surface for no win.
  // eslint-disable-next-line no-console
  console.log(msg)
}

function logError(msg: string, err?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(msg, err ?? '')
}

async function findExistingByName(
  db: ReturnType<typeof drizzle>,
  workspaceId: string,
  name: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: workflowsTable.id })
    .from(workflowsTable)
    .where(
      and(
        eq(workflowsTable.workspaceId, workspaceId),
        eq(workflowsTable.name, name),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

async function upsertTemplate(
  db: ReturnType<typeof drizzle>,
  workspaceId: string,
  template: WorkflowTemplate,
): Promise<SeedResult> {
  const existing = await findExistingByName(db, workspaceId, template.name)
  if (existing) {
    const rows = await db
      .update(workflowsTable)
      .set({
        prompt: template.prompt,
        schedule: template.schedule,
        // jsonb columns: drizzle-orm accepts a serializable value; the
        // type plumbing is `never`-typed in workflowsRepo too, hence the
        // localized cast.
        requiredCredentials: template.requiredCredentials as never,
        checkModules: template.checkModules as never,
        enabled: template.enabled,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowsTable.id, existing.id),
          eq(workflowsTable.workspaceId, workspaceId),
        ),
      )
      .returning({ id: workflowsTable.id })
    const id = rows[0]?.id
    if (!id) {
      throw new Error(
        `update returned no row for "${template.name}" (id=${existing.id})`,
      )
    }
    return { name: template.name, id, action: 'updated' }
  }

  const rows = await db
    .insert(workflowsTable)
    .values({
      workspaceId,
      name: template.name,
      prompt: template.prompt,
      schedule: template.schedule,
      requiredCredentials: template.requiredCredentials as never,
      checkModules: template.checkModules as never,
      enabled: template.enabled,
    })
    .returning({ id: workflowsTable.id })
  const id = rows[0]?.id
  if (!id) {
    throw new Error(`insert returned no row for "${template.name}"`)
  }
  return { name: template.name, id, action: 'inserted' }
}

export async function seedTemplates(opts: {
  workspaceId: string
  databaseUrl: string
}): Promise<SeedResult[]> {
  // Same connection settings as `api/src/db/index.ts` — `prepare: false`
  // is the load-bearing one for Supabase's transaction pooler.
  const sql = postgres(opts.databaseUrl, {
    max: 2,
    prepare: false,
    ...tlsOptsForPostgresUrl(opts.databaseUrl),
  })
  try {
    const db = drizzle(sql)
    const results: SeedResult[] = []
    for (const template of ALL_TEMPLATES) {
      const r = await upsertTemplate(db, opts.workspaceId, template)
      results.push(r)
      log(`  ${r.action === 'inserted' ? '+' : '~'} ${r.name}  (id=${r.id})`)
    }
    return results
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    logError('DATABASE_URL is required.')
    process.exit(1)
  }
  const workspaceId = process.env.SEED_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID

  log(
    `Seeding ${ALL_TEMPLATES.length} launch templates into workspace_id=${workspaceId}`,
  )
  log('')

  let results: SeedResult[]
  try {
    results = await seedTemplates({ workspaceId, databaseUrl })
  } catch (err) {
    logError('Seed failed:', err instanceof Error ? err.message : err)
    process.exit(2)
  }

  log('')
  const inserted = results.filter((r) => r.action === 'inserted').length
  const updated = results.filter((r) => r.action === 'updated').length
  log(`Done. ${inserted} inserted, ${updated} updated.`)
}

// Run only when invoked directly (not when imported by tests).
const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  /seed(\.ts|\.js|\.mjs)?$/.test(process.argv[1])

if (isDirectInvocation) {
  void main()
}

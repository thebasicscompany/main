import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { workspaceCredentials } from '../db/schema-public.js'
import { decryptCredential } from '../lib/kms.js'
import { logger } from '../middleware/logger.js'

export class CredentialNotProvisionedError extends Error {
  constructor(public readonly meta: { workspaceId: string; kind: string }) {
    super(`no active credential for kind=${meta.kind}`)
    this.name = 'CredentialNotProvisionedError'
  }
}

export class NoCredentialError extends Error {
  constructor(public readonly meta: { workspaceId: string; kind: string }) {
    super(`no credential available for kind=${meta.kind}`)
    this.name = 'NoCredentialError'
  }
}

export type GatewayCredentialTag =
  | 'customer_byok'
  | 'basics_managed_per_workspace'
  | 'basics_managed_pooled'

export interface ResolvedGatewayCredential {
  plaintext: string
  credentialId: string | null
  usageTag: GatewayCredentialTag
}

const KMS_PENDING = 'not_applicable'

/** Postgres / Drizzle wraps driver errors (`cause`). Walk the chain + SQLSTATE `code`. */
function postgresCodeInChain(err: unknown): string | undefined {
  let cur: unknown = err
  for (let depth = 0; depth < 12 && cur != null; depth++) {
    const e = cur as { code?: unknown; cause?: unknown }
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      return e.code
    }
    cur = e.cause
  }
  return undefined
}

/** BYOK columns missing or table absent — behave like no workspace credential until migrations run. */
function isCredentialSchemaNotReady(err: unknown): boolean {
  const sqlState = postgresCodeInChain(err)
  if (sqlState === '42703' || sqlState === '42P01') return true

  let cur: unknown = err
  for (let depth = 0; depth < 12 && cur != null; depth++) {
    const e = cur as { code?: string; message?: string; cause?: unknown }
    const msg = (e.message ?? '').toLowerCase()
    // Drizzle top-level: `Failed query: ... "workspace_credentials" ...`; Postgres cause: relation does not exist
    if (msg.includes('workspace_credentials')) {
      if (
        msg.includes('does not exist') ||
        msg.includes('undefined_column') ||
        msg.includes('undefined column')
      ) {
        return true
      }
    }
    cur = e.cause
  }
  return false
}

async function fetchCredentialRows(
  workspaceId: string,
  kind: string,
  label: string,
) {
  const db = getDb()
  return db
    .select()
    .from(workspaceCredentials)
    .where(
      and(
        eq(workspaceCredentials.workspaceId, workspaceId),
        eq(workspaceCredentials.kind, kind),
        eq(workspaceCredentials.label, label),
      ),
    )
}

/**
 * Ensure managed placeholder rows exist so gateways can resolve pooled mode (Phase 4).
 */
export async function seedManagedCredentialPlaceholders(workspaceId: string): Promise<void> {
  const db = getDb()
  const kinds = ['anthropic', 'openai', 'gemini'] as const
  for (const kind of kinds) {
    await db
      .insert(workspaceCredentials)
      .values({
        workspaceId,
        kind,
        label: '',
        provenance: 'basics_managed',
        status: 'not_provisioned',
        ciphertext: null,
        kmsKeyId: KMS_PENDING,
      })
      .onConflictDoNothing({
        target: [
          workspaceCredentials.workspaceId,
          workspaceCredentials.kind,
          workspaceCredentials.label,
        ],
      })
  }
}

/** Ordered lookup: BYOK active → managed active → managed not_provisioned placeholder. */
async function pickResolvedRow(
  workspaceId: string,
  kind: string,
  label: string,
): Promise<(typeof workspaceCredentials.$inferSelect) | null> {
  const rows = await fetchCredentialRows(workspaceId, kind, label)
  const byok = rows.find(
    (r) =>
      r.provenance === 'customer_byok' &&
      r.status === 'active' &&
      r.ciphertext,
  )
  if (byok) return byok
  const managedActive = rows.find(
    (r) =>
      r.provenance === 'basics_managed' &&
      r.status === 'active' &&
      r.ciphertext,
  )
  if (managedActive) return managedActive
  const placeholder = rows.find(
    (r) => r.provenance === 'basics_managed' && r.status === 'not_provisioned',
  )
  if (placeholder) return placeholder
  return null
}

/**
 * Orchestrator / Surface B: active ciphertext rows only; env fallback handled in `getAnthropicClientForWorkspace`.
 */
export async function resolveActiveCredential(opts: {
  workspaceId: string
  kind: string
  label?: string
}): Promise<{ plaintext: string; provenance: string; credentialId: string }> {
  const label = opts.label ?? ''
  try {
    const db = getDb()
    const base = and(
      eq(workspaceCredentials.workspaceId, opts.workspaceId),
      eq(workspaceCredentials.kind, opts.kind),
      eq(workspaceCredentials.label, label),
      eq(workspaceCredentials.status, 'active'),
    )
    const byokRows = await db
      .select()
      .from(workspaceCredentials)
      .where(and(base, eq(workspaceCredentials.provenance, 'customer_byok')))
      .limit(1)
    let row = byokRows[0]
    if (!row?.ciphertext) {
      const managedRows = await db
        .select()
        .from(workspaceCredentials)
        .where(and(base, eq(workspaceCredentials.provenance, 'basics_managed')))
        .limit(1)
      row = managedRows[0]
    }
    if (!row?.ciphertext) {
      throw new CredentialNotProvisionedError({
        workspaceId: opts.workspaceId,
        kind: opts.kind,
      })
    }
    const plaintext = await decryptCredential(row.ciphertext)
    await db
      .update(workspaceCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(workspaceCredentials.id, row.id))
      .catch((e) => logger.warn({ err: e }, 'lastUsedAt update failed'))
    return { plaintext, provenance: row.provenance, credentialId: row.id }
  } catch (e) {
    if (e instanceof CredentialNotProvisionedError) throw e
    if (isCredentialSchemaNotReady(e)) {
      logger.warn(
        { workspace_id: opts.workspaceId, kind: opts.kind },
        'workspace_credentials not ready (run migrations); treating as no row',
      )
      throw new CredentialNotProvisionedError({
        workspaceId: opts.workspaceId,
        kind: opts.kind,
      })
    }
    throw e
  }
}

/** Managed proxy: §7.3 resolution order + optional pooled env keys. */
export async function resolveGatewayCredential(opts: {
  workspaceId: string
  kind: string
  label?: string
  pooledKey: string | undefined
}): Promise<ResolvedGatewayCredential> {
  const label = opts.label ?? ''
  let row: Awaited<ReturnType<typeof pickResolvedRow>> | null = null
  try {
    await seedManagedCredentialPlaceholders(opts.workspaceId)
    row = await pickResolvedRow(opts.workspaceId, opts.kind, label)
  } catch (e) {
    if (!isCredentialSchemaNotReady(e)) throw e
    logger.warn(
      { workspace_id: opts.workspaceId, kind: opts.kind },
      'workspace_credentials not ready (run migrations); skipping DB lookup for managed proxy',
    )
  }
  if (row?.ciphertext && row.status === 'active') {
    const plaintext = await decryptCredential(row.ciphertext)
    const db = getDb()
    await db
      .update(workspaceCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(workspaceCredentials.id, row.id))
      .catch((e) => logger.warn({ err: e }, 'lastUsedAt update failed'))
    const usageTag: GatewayCredentialTag =
      row.provenance === 'customer_byok' ? 'customer_byok' : 'basics_managed_per_workspace'
    return { plaintext, credentialId: row.id, usageTag }
  }
  const pooled = opts.pooledKey?.trim()
  if (pooled) {
    return {
      plaintext: pooled,
      credentialId: null,
      usageTag: 'basics_managed_pooled',
    }
  }
  throw new NoCredentialError({ workspaceId: opts.workspaceId, kind: opts.kind })
}

export async function markCredentialAuthFailed(credentialId: string): Promise<void> {
  const db = getDb()
  await db
    .update(workspaceCredentials)
    .set({
      lastProviderError: 'auth_failed',
      lastProviderErrorAt: new Date(),
    })
    .where(eq(workspaceCredentials.id, credentialId))
}

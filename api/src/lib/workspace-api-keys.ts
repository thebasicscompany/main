import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { workspaceApiKeys, type WorkspaceApiKeyRow } from '../db/schema-public.js'
import type { WorkspaceToken } from './jwt.js'

const KEY_PREFIX = 'bas_live'
const DEFAULT_ASSISTANT_SCOPE = 'llm:managed'
const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000'

export type AuthenticatedWorkspaceApiKey = {
  id: string
  workspaceId: string
  name: string
  scopes: string[]
}

export type WorkspaceApiKeyMeta = {
  id: string
  workspaceId: string
  name: string
  prefix: string
  scopes: string[]
  status: 'active' | 'revoked'
  createdByAccountId: string | null
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  metadata: Record<string, unknown>
}

export class InvalidWorkspaceApiKeyError extends Error {}
export class WorkspaceApiKeyForbiddenError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
  }
}

function hashSecret(secret: string): string {
  const cfg = getConfig()
  const hashSecretValue = cfg.WORKSPACE_API_KEY_HASH_SECRET ?? cfg.WORKSPACE_JWT_SECRET
  if (cfg.NODE_ENV === 'production' && !cfg.WORKSPACE_API_KEY_HASH_SECRET) {
    throw new Error('WORKSPACE_API_KEY_HASH_SECRET is required in production')
  }
  return createHmac('sha256', hashSecretValue).update(secret).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function generateSecret(): { key: string; prefix: string; secret: string } {
  const prefixToken = randomBytes(8).toString('base64url')
  const secret = randomBytes(32).toString('base64url')
  const prefix = `${KEY_PREFIX}_${prefixToken}`
  return { key: `${prefix}_${secret}`, prefix, secret }
}

function extractPrefix(key: string): string | null {
  const parts = key.split('_')
  if (parts.length < 4) return null
  if (`${parts[0]}_${parts[1]}` !== KEY_PREFIX) return null
  return `${parts[0]}_${parts[1]}_${parts[2]}`
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return []
  return scopes.filter((s): s is string => typeof s === 'string' && s.length > 0)
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  return metadata as Record<string, unknown>
}

export function workspaceApiKeyToMeta(row: WorkspaceApiKeyRow): WorkspaceApiKeyMeta {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    scopes: normalizeScopes(row.scopes),
    status: row.status as 'active' | 'revoked',
    createdByAccountId: row.createdByAccountId ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    metadata: normalizeMetadata(row.metadata),
  }
}

export async function createWorkspaceApiKey(opts: {
  workspaceId: string
  createdByAccountId: string | null
  name: string
  scopes: string[]
  expiresAt?: Date | null
  metadata?: Record<string, unknown>
}): Promise<{ key: string; meta: WorkspaceApiKeyMeta }> {
  const db = getDb()
  const generated = generateSecret()
  const now = new Date()
  const inserted = await db
    .insert(workspaceApiKeys)
    .values({
      workspaceId: opts.workspaceId,
      name: opts.name,
      prefix: generated.prefix,
      secretHash: hashSecret(generated.key),
      scopes: opts.scopes,
      status: 'active',
      createdByAccountId: opts.createdByAccountId,
      createdAt: now,
      expiresAt: opts.expiresAt ?? null,
      metadata: opts.metadata ?? {},
    })
    .returning()
  const row = inserted[0]
  if (!row) throw new Error('workspace_api_key_insert_failed')
  return { key: generated.key, meta: workspaceApiKeyToMeta(row) }
}

export async function listWorkspaceApiKeys(workspaceId: string): Promise<WorkspaceApiKeyMeta[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(workspaceApiKeys)
    .where(eq(workspaceApiKeys.workspaceId, workspaceId))
  return rows.map(workspaceApiKeyToMeta)
}

export async function revokeWorkspaceApiKey(opts: {
  workspaceId: string
  apiKeyId: string
}): Promise<boolean> {
  const db = getDb()
  const updated = await db
    .update(workspaceApiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(workspaceApiKeys.id, opts.apiKeyId),
        eq(workspaceApiKeys.workspaceId, opts.workspaceId),
      ),
    )
    .returning({ id: workspaceApiKeys.id })
  return Boolean(updated[0])
}

export async function authenticateWorkspaceApiKey(
  key: string,
  requiredScope: string,
): Promise<{ workspace: WorkspaceToken; apiKey: AuthenticatedWorkspaceApiKey }> {
  const prefix = extractPrefix(key)
  if (!prefix) throw new InvalidWorkspaceApiKeyError('invalid_api_key')

  const db = getDb()
  const rows = await db
    .select()
    .from(workspaceApiKeys)
    .where(eq(workspaceApiKeys.prefix, prefix))
    .limit(1)
  const row = rows[0]
  if (!row || !constantTimeEqual(hashSecret(key), row.secretHash)) {
    throw new InvalidWorkspaceApiKeyError('invalid_api_key')
  }
  if (row.status !== 'active') {
    throw new WorkspaceApiKeyForbiddenError('api_key_revoked')
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new WorkspaceApiKeyForbiddenError('api_key_expired')
  }
  const scopes = normalizeScopes(row.scopes)
  if (!scopes.includes(requiredScope)) {
    throw new WorkspaceApiKeyForbiddenError('insufficient_scope')
  }

  void db
    .update(workspaceApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(workspaceApiKeys.id, row.id))
    .catch(() => {})

  const now = new Date()
  return {
    workspace: {
      workspace_id: row.workspaceId,
      account_id: row.createdByAccountId ?? SYSTEM_ACCOUNT_ID,
      plan: 'team',
      seat_status: 'active',
      issued_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? new Date(now.getTime() + 86_400_000).toISOString(),
    },
    apiKey: {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      scopes,
    },
  }
}

export async function rotateAssistantApiKey(opts: {
  workspaceId: string
  accountId: string
  clientInstallationId: string
  assistantId: string
  assistantVersion?: string | null
  platform: string
  machineName?: string | null
}): Promise<{ key: string; meta: WorkspaceApiKeyMeta }> {
  const db = getDb()
  await db
    .update(workspaceApiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(workspaceApiKeys.workspaceId, opts.workspaceId),
        eq(workspaceApiKeys.status, 'active'),
        sql`${workspaceApiKeys.metadata}->>'kind' = 'assistant'`,
        sql`${workspaceApiKeys.metadata}->>'client_installation_id' = ${opts.clientInstallationId}`,
        sql`${workspaceApiKeys.metadata}->>'assistant_id' = ${opts.assistantId}`,
      ),
    )

  return createWorkspaceApiKey({
    workspaceId: opts.workspaceId,
    createdByAccountId: opts.accountId,
    name: `Basics Assistant ${opts.assistantId}`,
    scopes: [DEFAULT_ASSISTANT_SCOPE],
    metadata: {
      kind: 'assistant',
      client_installation_id: opts.clientInstallationId,
      assistant_id: opts.assistantId,
      assistant_version: opts.assistantVersion ?? null,
      platform: opts.platform,
      machine_name: opts.machineName ?? null,
    },
  })
}

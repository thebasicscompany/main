import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { workspaceCredentials } from '../db/schema-public.js'
import { DatabaseUnavailableError } from '../lib/errors.js'
import { encryptCredential } from '../lib/kms.js'
import type { WorkspacePlan, WorkspaceToken } from '../lib/jwt.js'
import {
  createWorkspaceApiKey,
  listWorkspaceApiKeys,
  revokeWorkspaceApiKey,
} from '../lib/workspace-api-keys.js'
import { logger } from '../middleware/logger.js'
import { requireAdmin, type AdminVars } from '../middleware/require-admin.js'

function workspaceMismatch(c: { req: { param: (k: string) => string }; var: { workspace: WorkspaceToken } }) {
  const wid = c.req.param('workspaceId')
  if (wid !== c.var.workspace.workspace_id) {
    return { json: { error: 'forbidden', reason: 'workspace_mismatch' }, status: 403 as const }
  }
  return null
}

function rowToMeta(row: typeof workspaceCredentials.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    label: row.label,
    provenance: row.provenance as 'basics_managed' | 'customer_byok',
    status: row.status as 'active' | 'not_provisioned' | 'cleared',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastProviderError: row.lastProviderError ?? null,
    lastProviderErrorAt: row.lastProviderErrorAt?.toISOString() ?? null,
  }
}

const postBodySchema = z
  .object({
    kind: z.string().min(1),
    label: z.string().optional().default(''),
    plaintext: z.string().min(1),
    provenance: z.enum(['basics_managed', 'customer_byok']).optional(),
  })
  .strict()

const patchBodySchema = z
  .object({
    plaintext: z.string().min(1).optional(),
    label: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.plaintext) !== Boolean(b.label), {
    message: 'exactly one of plaintext or label',
  })

const allowedApiKeyScopes = ['llm:managed'] as const

const apiKeyPostBodySchema = z
  .object({
    name: z.string().min(1).max(256),
    scopes: z.array(z.enum(allowedApiKeyScopes)).min(1).optional(),
    expires_at: z.string().datetime().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const credentialRoutes = new Hono<{ Variables: AdminVars }>()

credentialRoutes.get('/:workspaceId/api-keys', requireAdmin, async (c) => {
  const bad = workspaceMismatch(c)
  if (bad) return c.json(bad.json, bad.status)
  try {
    const apiKeys = await listWorkspaceApiKeys(c.var.workspace.workspace_id)
    return c.json({ api_keys: apiKeys }, 200)
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured' }, 503)
    }
    logger.error({ err: e }, 'workspace api key list failed')
    throw e
  }
})

credentialRoutes.post(
  '/:workspaceId/api-keys',
  zValidator('json', apiKeyPostBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'invalid_request',
          code: 'validation_failed',
          issues: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  requireAdmin,
  async (c) => {
    const bad = workspaceMismatch(c)
    if (bad) return c.json(bad.json, bad.status)
    const body = c.req.valid('json')
    try {
      const created = await createWorkspaceApiKey({
        workspaceId: c.var.workspace.workspace_id,
        createdByAccountId: c.var.workspace.account_id,
        name: body.name,
        scopes: body.scopes ?? ['llm:managed'],
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        metadata: body.metadata ?? {},
      })
      return c.json({ ...created.meta, key: created.key }, 201)
    } catch (e) {
      if (e instanceof DatabaseUnavailableError) {
        return c.json({ error: 'not_configured' }, 503)
      }
      logger.error({ err: e }, 'workspace api key create failed')
      throw e
    }
  },
)

credentialRoutes.delete('/:workspaceId/api-keys/:apiKeyId', requireAdmin, async (c) => {
  const bad = workspaceMismatch(c)
  if (bad) return c.json(bad.json, bad.status)
  try {
    const ok = await revokeWorkspaceApiKey({
      workspaceId: c.var.workspace.workspace_id,
      apiKeyId: c.req.param('apiKeyId'),
    })
    if (!ok) return c.json({ error: 'not_found' }, 404)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured' }, 503)
    }
    logger.error({ err: e }, 'workspace api key revoke failed')
    throw e
  }
})

credentialRoutes.get('/:workspaceId/credentials', requireAdmin, async (c) => {
  const bad = workspaceMismatch(c)
  if (bad) return c.json(bad.json, bad.status)
  try {
    const db = getDb()
    const rows = await db
      .select()
      .from(workspaceCredentials)
      .where(eq(workspaceCredentials.workspaceId, c.var.workspace.workspace_id))
    return c.json({ credentials: rows.map(rowToMeta) }, 200)
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured' }, 503)
    }
    logger.error({ err: e }, 'credentials list failed')
    throw e
  }
})

credentialRoutes.post(
  '/:workspaceId/credentials',
  zValidator('json', postBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'invalid_request',
          code: 'validation_failed',
          issues: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  requireAdmin,
  async (c) => {
    const bad = workspaceMismatch(c)
    if (bad) return c.json(bad.json, bad.status)
    const body = c.req.valid('json')
    const provenance = body.provenance ?? 'customer_byok'
    if (provenance === 'customer_byok') {
      const plan = c.var.workspace.plan as WorkspacePlan
      if (plan === 'free' || plan === 'pro') {
        const cfg = getConfig()
        return c.json(
          {
            error: 'payment_required',
            reason: 'byok_requires_team_plan',
            upgrade_url: cfg.BYOK_UPGRADE_URL ?? null,
          },
          402,
        )
      }
    }
    const workspaceId = c.var.workspace.workspace_id
    const accountId = c.var.workspace.account_id
    try {
      const db = getDb()
      const existing = await db
        .select()
        .from(workspaceCredentials)
        .where(
          and(
            eq(workspaceCredentials.workspaceId, workspaceId),
            eq(workspaceCredentials.kind, body.kind),
            eq(workspaceCredentials.label, body.label ?? ''),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (row?.status === 'active') {
        return c.json(
          { error: 'conflict', reason: 'credential_active_exists', hint: 'use PATCH to rotate' },
          409,
        )
      }
      const enc = await encryptCredential(body.plaintext)
      const now = new Date()
      if (!row) {
        await db.insert(workspaceCredentials).values({
          workspaceId,
          kind: body.kind,
          label: body.label ?? '',
          provenance,
          status: 'active',
          ciphertext: enc.ciphertext,
          kmsKeyId: enc.kmsKeyId,
          createdBy: accountId,
          createdAt: now,
          updatedAt: now,
          lastProviderError: null,
          lastProviderErrorAt: null,
        })
        const inserted = await db
          .select()
          .from(workspaceCredentials)
          .where(
            and(
              eq(workspaceCredentials.workspaceId, workspaceId),
              eq(workspaceCredentials.kind, body.kind),
              eq(workspaceCredentials.label, body.label ?? ''),
            ),
          )
          .limit(1)
        const created = inserted[0]
        if (!created) return c.json({ error: 'internal_error' }, 500)
        return c.json(rowToMeta(created), 201)
      }
      await db
        .update(workspaceCredentials)
        .set({
          provenance,
          status: 'active',
          ciphertext: enc.ciphertext,
          kmsKeyId: enc.kmsKeyId,
          updatedAt: now,
          rotatedAt: now,
          lastProviderError: null,
          lastProviderErrorAt: null,
        })
        .where(eq(workspaceCredentials.id, row.id))
      const updated = await db
        .select()
        .from(workspaceCredentials)
        .where(eq(workspaceCredentials.id, row.id))
        .limit(1)
      const u = updated[0]
      if (!u) return c.json({ error: 'internal_error' }, 500)
      return c.json(rowToMeta(u), 201)
    } catch (e) {
      if (e instanceof DatabaseUnavailableError) {
        return c.json({ error: 'not_configured' }, 503)
      }
      if (e instanceof Error && e.message.includes('kms:')) {
        return c.json({ error: 'upstream_unavailable', reason: 'kms_error' }, 502)
      }
      logger.error({ err: e }, 'credential create failed')
      throw e
    }
  },
)

credentialRoutes.patch(
  '/:workspaceId/credentials/:credentialId',
  zValidator('json', patchBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'invalid_request',
          code: 'validation_failed',
          issues: z.flattenError(result.error),
        },
        400,
      )
    }
    return undefined
  }),
  requireAdmin,
  async (c) => {
    const bad = workspaceMismatch(c)
    if (bad) return c.json(bad.json, bad.status)
    const credentialId = c.req.param('credentialId')
    const body = c.req.valid('json')
    const workspaceId = c.var.workspace.workspace_id
    try {
      const db = getDb()
      const rows = await db
        .select()
        .from(workspaceCredentials)
        .where(
          and(
            eq(workspaceCredentials.id, credentialId),
            eq(workspaceCredentials.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (!row) return c.json({ error: 'not_found' }, 404)

      const now = new Date()
      if (body.plaintext) {
        const enc = await encryptCredential(body.plaintext)
        await db
          .update(workspaceCredentials)
          .set({
            status: 'active',
            ciphertext: enc.ciphertext,
            kmsKeyId: enc.kmsKeyId,
            updatedAt: now,
            rotatedAt: now,
            lastProviderError: null,
            lastProviderErrorAt: null,
          })
          .where(eq(workspaceCredentials.id, credentialId))
      } else if (body.label !== undefined) {
        const conflict = await db
          .select({ id: workspaceCredentials.id })
          .from(workspaceCredentials)
          .where(
            and(
              eq(workspaceCredentials.workspaceId, workspaceId),
              eq(workspaceCredentials.kind, row.kind),
              eq(workspaceCredentials.label, body.label),
            ),
          )
          .limit(1)
        if (conflict[0] && conflict[0].id !== credentialId) {
          return c.json({ error: 'conflict', reason: 'label_in_use' }, 409)
        }
        await db
          .update(workspaceCredentials)
          .set({ label: body.label, updatedAt: now })
          .where(eq(workspaceCredentials.id, credentialId))
      }

      const out = await db
        .select()
        .from(workspaceCredentials)
        .where(eq(workspaceCredentials.id, credentialId))
        .limit(1)
      const final = out[0]
      if (!final) return c.json({ error: 'internal_error' }, 500)
      return c.json(rowToMeta(final), 200)
    } catch (e) {
      if (e instanceof DatabaseUnavailableError) {
        return c.json({ error: 'not_configured' }, 503)
      }
      if (e instanceof Error && e.message.includes('kms:')) {
        return c.json({ error: 'upstream_unavailable', reason: 'kms_error' }, 502)
      }
      logger.error({ err: e }, 'credential patch failed')
      throw e
    }
  },
)

credentialRoutes.delete('/:workspaceId/credentials/:credentialId', requireAdmin, async (c) => {
  const bad = workspaceMismatch(c)
  if (bad) return c.json(bad.json, bad.status)
  const credentialId = c.req.param('credentialId')
  const workspaceId = c.var.workspace.workspace_id
  try {
    const db = getDb()
    const rows = await db
      .select({ id: workspaceCredentials.id })
      .from(workspaceCredentials)
      .where(
        and(eq(workspaceCredentials.id, credentialId), eq(workspaceCredentials.workspaceId, workspaceId)),
      )
      .limit(1)
    if (!rows[0]) return c.json({ error: 'not_found' }, 404)
    await db
      .update(workspaceCredentials)
      .set({
        status: 'cleared',
        ciphertext: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaceCredentials.id, credentialId))
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) {
      return c.json({ error: 'not_configured' }, 503)
    }
    logger.error({ err: e }, 'credential delete failed')
    throw e
  }
})

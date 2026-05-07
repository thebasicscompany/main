/**
 * /v1/runtime/trust-grants — Phase 09.
 *
 *   GET    /v1/runtime/trust-grants                — list workspace's grants
 *   GET    /v1/runtime/trust-grants/:id            — fetch one grant
 *   POST   /v1/runtime/trust-grants                — create a grant
 *   DELETE /v1/runtime/trust-grants/:id            — revoke a grant
 *
 * Auth: workspace JWT (mounted in app.ts via requireWorkspaceJwt).
 *
 * Locked decisions (HANDOFF + ROADMAP Phase 09):
 *   - The `runtime_trust_grants` table already exists; no migration here.
 *   - Match logic + memory/Drizzle repo live in `orchestrator/trustLedger.ts`.
 *     This route is a thin CRUD layer; the auto-approve evaluation in
 *     `middleware/approval.ts` reads through the same repo, so a grant
 *     created here is honored on the next gated tool call.
 *   - Soft-delete on revoke: the `revoked_at` + `revoked_by` columns are
 *     populated; the row stays so the audit/history view can render
 *     revoked grants (per PROJECT.md "trust grants narrow, never widen"
 *     — revocation is data, not erasure).
 *   - Cross-workspace access leaks the existence of the grant; we return
 *     404 (not 403) for grants owned by other workspaces, mirroring the
 *     approval-resolve route's posture.
 *   - Trust grants reference `action_pattern` (a tool-name glob); Phase 10
 *     workflow definitions reference `requiredCredentials` (a separate
 *     concept naming the credentials a workflow needs at boot). Distinct
 *     surfaces — a grant is "auto-approve THIS action," a workflow's
 *     `requiredCredentials` is "this workflow can't run without THESE
 *     creds."
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WorkspaceToken } from '../lib/jwt.js'
import { logger } from '../middleware/logger.js'
import {
  create as createTrustGrant,
  get as getTrustGrant,
  list as listTrustGrants,
  revoke as revokeTrustGrant,
  type TrustGrantRecord,
} from '../orchestrator/trustLedger.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const trustGrantsRoute = new Hono<{ Variables: Vars }>()

// =============================================================================
// Wire shape — snake_case keys to match the rest of the runtime API.
// =============================================================================

function toWire(rec: TrustGrantRecord): Record<string, unknown> {
  return {
    id: rec.id,
    workspace_id: rec.workspaceId,
    granted_by: rec.grantedBy,
    action_pattern: rec.actionPattern,
    params_constraint: rec.paramsConstraint,
    scope: rec.scope,
    expires_at: rec.expiresAt,
    revoked_at: rec.revokedAt,
    revoked_by: rec.revokedBy,
    created_at: rec.createdAt,
  }
}

// =============================================================================
// GET /v1/runtime/trust-grants — list with optional filters + pagination.
// =============================================================================

const listQuerySchema = z.object({
  action_pattern: z.string().min(1).optional(),
  include_expired: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

trustGrantsRoute.get('/', async (c) => {
  const workspace = c.get('workspace')
  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams.entries()),
  )
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        code: 'validation_failed',
        issues: z.flattenError(parsed.error),
      },
      400,
    )
  }
  const q = parsed.data
  const limit = q.limit ?? 50
  const offset = q.offset ?? 0
  const records = await listTrustGrants({
    workspaceId: workspace.workspace_id,
    ...(q.action_pattern !== undefined ? { actionPattern: q.action_pattern } : {}),
    ...(q.include_expired !== undefined ? { includeExpired: q.include_expired } : {}),
    limit,
    offset,
  })
  // `total` is the count of rows that match the same filter without
  // pagination. The repo doesn't expose a count(*) helper today; v1 uses
  // a light-weight upper-bound: `offset + records.length` when the page
  // is full, else `offset + records.length`. The route's pagination
  // contract is best-effort until the repo grows a real count method —
  // documented here so consumers don't treat `total` as authoritative.
  const total = offset + records.length
  return c.json(
    {
      grants: records.map(toWire),
      limit,
      offset,
      total,
    },
    200,
  )
})

// =============================================================================
// GET /v1/runtime/trust-grants/:id — fetch one grant.
// =============================================================================

trustGrantsRoute.get('/:id', async (c) => {
  const workspace = c.get('workspace')
  const grantId = c.req.param('id')
  const rec = await getTrustGrant(workspace.workspace_id, grantId)
  if (!rec) {
    return c.json({ error: 'trust_grant_not_found' }, 404)
  }
  return c.json(toWire(rec), 200)
})

// =============================================================================
// POST /v1/runtime/trust-grants — create a grant.
//
// `granted_by` is taken from the JWT's `account_id` so a workspace member
// can't impersonate another user. `params_constraint` defaults to `{}`
// (matches anything). `scope` is `workspace` | `workflow:<id>` per the
// match logic in trustLedger.ts.
// =============================================================================

const scopeSchema = z
  .string()
  .min(1)
  .refine(
    (s) => s === 'workspace' || s.startsWith('workflow:'),
    {
      message: "scope must be 'workspace' or 'workflow:<id>'",
    },
  )

const createBodySchema = z
  .object({
    action_pattern: z.string().min(1),
    params_constraint: z.record(z.string(), z.unknown()).optional(),
    scope: scopeSchema,
    expires_at: z.iso.datetime().optional(),
  })
  .strict()

trustGrantsRoute.post(
  '/',
  zValidator('json', createBodySchema, (result, c) => {
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
  async (c) => {
    const workspace = c.get('workspace')
    const body = c.req.valid('json')
    try {
      const rec = await createTrustGrant({
        workspaceId: workspace.workspace_id,
        grantedBy: workspace.account_id,
        actionPattern: body.action_pattern,
        ...(body.params_constraint !== undefined
          ? { paramsConstraint: body.params_constraint }
          : {}),
        scope: body.scope,
        ...(body.expires_at !== undefined
          ? { expiresAt: new Date(body.expires_at) }
          : {}),
      })
      return c.json(toWire(rec), 201)
    } catch (err) {
      logger.error(
        {
          requestId: c.get('requestId'),
          workspace_id: workspace.workspace_id,
          err: { message: (err as Error).message },
        },
        'trust grant create failed',
      )
      throw err
    }
  },
)

// =============================================================================
// DELETE /v1/runtime/trust-grants/:id — revoke a grant.
//
// Soft-delete: writes `revoked_at` + `revoked_by`. Idempotency: revoking
// an already-revoked grant returns 204 (the row is in the desired state).
// Cross-workspace returns 404 (existence is privileged information).
// =============================================================================

trustGrantsRoute.delete('/:id', async (c) => {
  const workspace = c.get('workspace')
  const grantId = c.req.param('id')

  // Workspace ownership check before the write so a cross-workspace caller
  // can't infer the grant exists by observing revocation timing.
  const existing = await getTrustGrant(workspace.workspace_id, grantId)
  if (!existing) {
    return c.json({ error: 'trust_grant_not_found' }, 404)
  }

  await revokeTrustGrant(grantId, workspace.account_id)
  return c.body(null, 204)
})

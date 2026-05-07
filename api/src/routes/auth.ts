import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase.js'
import { signWorkspaceToken, type WorkspacePlan, type WorkspaceToken } from '../lib/jwt.js'
import { logger } from '../middleware/logger.js'

const TOKEN_TTL_SECONDS = 24 * 60 * 60

const tokenBodySchema = z
  .object({
    supabase_access_token: z.string().min(1),
    workspace_id: z.string().uuid().optional(),
  })
  .strict()

type Vars = { requestId: string }

export const authRoutes = new Hono<{ Variables: Vars }>()

/**
 * POST /v1/auth/token
 *
 * Trades a Supabase access token for a 24h HS256 workspace JWT.
 *
 * Flow:
 *  1. Verify Supabase access token via service-role client.
 *  2. Look up the corresponding `accounts` row.
 *  3. Resolve the target workspace (default = personal workspace).
 *  4. Verify the caller has an active seat on that workspace.
 *  5. Verify the workspace has an active/trialing subscription.
 *  6. Sign and return the JWT + workspace metadata.
 */
authRoutes.post(
  '/token',
  zValidator('json', tokenBodySchema, (result, c) => {
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
    const { supabase_access_token, workspace_id } = c.req.valid('json')
    const requestId = c.get('requestId')
    const admin = supabaseAdmin()

    // 1. Verify the Supabase access token.
    const { data: userData, error: userError } = await admin.auth.getUser(supabase_access_token)
    if (userError || !userData?.user) {
      return c.json(
        { error: 'invalid_token', message: 'Invalid Supabase access token' },
        401,
      )
    }
    const supabaseAuthId = userData.user.id

    // 2. Look up the Basics account row.
    const { data: account, error: accountError } = await admin
      .from('accounts')
      .select('id, supabase_auth_id')
      .eq('supabase_auth_id', supabaseAuthId)
      .maybeSingle()
    if (accountError) {
      logger.error(
        { requestId, err: accountError.message },
        'auth: accounts lookup failed',
      )
      return c.json({ error: 'internal_error' }, 500)
    }
    if (!account) {
      return c.json({ error: 'not_found' }, 404)
    }

    // 3. Resolve the target workspace.
    let targetWorkspaceId = workspace_id
    if (!targetWorkspaceId) {
      // Default = the account's personal workspace.
      const { data: personal, error: personalError } = await admin
        .from('workspace_members')
        .select('workspace_id, workspaces!inner(id, type)')
        .eq('account_id', account.id)
        .eq('seat_status', 'active')
        .eq('workspaces.type', 'personal')
        .maybeSingle()
      if (personalError) {
        logger.error(
          { requestId, err: personalError.message },
          'auth: personal workspace lookup failed',
        )
        return c.json({ error: 'internal_error' }, 500)
      }
      if (!personal) {
        return c.json({ error: 'not_found' }, 404)
      }
      targetWorkspaceId = personal.workspace_id as string
    }

    // 4. Verify seat is active on the target workspace.
    const { data: membership, error: membershipError } = await admin
      .from('workspace_members')
      .select('seat_status')
      .eq('workspace_id', targetWorkspaceId)
      .eq('account_id', account.id)
      .maybeSingle()
    if (membershipError) {
      logger.error(
        { requestId, err: membershipError.message },
        'auth: membership lookup failed',
      )
      return c.json({ error: 'internal_error' }, 500)
    }
    if (!membership || membership.seat_status !== 'active') {
      return c.json({ error: 'forbidden' }, 403)
    }

    // 5. Load workspace metadata.
    const { data: workspace, error: workspaceError } = await admin
      .from('workspaces')
      .select('id, name, type, slug')
      .eq('id', targetWorkspaceId)
      .maybeSingle()
    if (workspaceError) {
      logger.error(
        { requestId, err: workspaceError.message },
        'auth: workspace lookup failed',
      )
      return c.json({ error: 'internal_error' }, 500)
    }
    if (!workspace) {
      return c.json({ error: 'not_found' }, 404)
    }

    // 6. Check subscription status.
    const { data: subscription, error: subError } = await admin
      .from('subscriptions')
      .select('plan, status')
      .eq('workspace_id', targetWorkspaceId)
      .maybeSingle()
    if (subError) {
      logger.error(
        { requestId, err: subError.message },
        'auth: subscription lookup failed',
      )
      return c.json({ error: 'internal_error' }, 500)
    }
    if (!subscription) {
      return c.json({ error: 'subscription_inactive' }, 403)
    }
    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      return c.json({ error: 'subscription_inactive' }, 403)
    }

    // 7. Sign the workspace JWT.
    const plan = subscription.plan as WorkspacePlan
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + TOKEN_TTL_SECONDS * 1000)
    const payload: WorkspaceToken = {
      workspace_id: workspace.id as string,
      account_id: account.id as string,
      plan,
      seat_status: membership.seat_status as string,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    }
    const token = await signWorkspaceToken(payload)

    return c.json(
      {
        token,
        expires_at: payload.expires_at,
        workspace: {
          id: workspace.id as string,
          name: workspace.name as string,
          type: workspace.type as 'personal' | 'team',
          slug: workspace.slug as string,
          plan,
        },
      },
      200,
    )
  },
)

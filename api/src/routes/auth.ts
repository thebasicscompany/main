import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase.js'
import { signWorkspaceToken, type WorkspacePlan, type WorkspaceToken } from '../lib/jwt.js'
import { logger } from '../middleware/logger.js'
import { getConfig } from '../config.js'
import { requireEnv } from '../lib/errors.js'

const TOKEN_TTL_SECONDS = 24 * 60 * 60

const tokenBodySchema = z
  .object({
    supabase_access_token: z.string().min(1),
    workspace_id: z.string().uuid().optional(),
  })
  .strict()

const refreshBodySchema = z
  .object({
    supabase_refresh_token: z.string().min(1),
    workspace_id: z.string().uuid().optional(),
  })
  .strict()

type Vars = { requestId: string }

export const authRoutes = new Hono<{ Variables: Vars }>()

interface MintSuccess {
  ok: true
  body: {
    token: string
    expires_at: string
    workspace: {
      id: string
      name: string
      type: 'personal' | 'team'
      slug: string
      plan: WorkspacePlan
    }
  }
}

interface MintFailure {
  ok: false
  status: ContentfulStatusCode
  body: { error: string; message?: string }
}

/**
 * Verify a Supabase access token, resolve the caller's workspace, check
 * seat + subscription, and sign a fresh 24h workspace JWT.
 *
 * Shared by `/v1/auth/token` (initial sign-in) and `/v1/auth/refresh`
 * (rotation). The refresh route obtains its access token from Supabase's
 * grant_type=refresh_token endpoint before calling this helper.
 */
async function mintWorkspaceTokenForAccessToken(args: {
  supabaseAccessToken: string
  workspaceId?: string
  requestId: string
}): Promise<MintSuccess | MintFailure> {
  const { supabaseAccessToken, workspaceId, requestId } = args
  const admin = supabaseAdmin()

  // 1. Verify the Supabase access token.
  const { data: userData, error: userError } = await admin.auth.getUser(supabaseAccessToken)
  if (userError || !userData?.user) {
    return {
      ok: false,
      status: 401,
      body: { error: 'invalid_token', message: 'Invalid Supabase access token' },
    }
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
    return { ok: false, status: 500, body: { error: 'internal_error' } }
  }
  if (!account) {
    return { ok: false, status: 404, body: { error: 'not_found' } }
  }

  // 3. Resolve the target workspace.
  let targetWorkspaceId = workspaceId
  if (!targetWorkspaceId) {
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
      return { ok: false, status: 500, body: { error: 'internal_error' } }
    }
    if (!personal) {
      return { ok: false, status: 404, body: { error: 'not_found' } }
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
    return { ok: false, status: 500, body: { error: 'internal_error' } }
  }
  if (!membership || membership.seat_status !== 'active') {
    return { ok: false, status: 403, body: { error: 'forbidden' } }
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
    return { ok: false, status: 500, body: { error: 'internal_error' } }
  }
  if (!workspace) {
    return { ok: false, status: 404, body: { error: 'not_found' } }
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
    return { ok: false, status: 500, body: { error: 'internal_error' } }
  }
  if (!subscription) {
    return { ok: false, status: 403, body: { error: 'subscription_inactive' } }
  }
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    return { ok: false, status: 403, body: { error: 'subscription_inactive' } }
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

  return {
    ok: true,
    body: {
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
  }
}

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
    const result = await mintWorkspaceTokenForAccessToken({
      supabaseAccessToken: supabase_access_token,
      workspaceId: workspace_id,
      requestId,
    })
    if (!result.ok) {
      return c.json(result.body, result.status)
    }
    return c.json(result.body, 200)
  },
)

/**
 * POST /v1/auth/refresh
 *
 * Rotates the Supabase refresh token and re-mints the workspace JWT.
 *
 * Flow:
 *  1. Call Supabase `/auth/v1/token?grant_type=refresh_token` with the
 *     stored refresh_token to obtain a fresh access_token + rotated
 *     refresh_token.
 *  2. Re-mint a fresh 24h workspace JWT via the shared helper.
 *  3. Return the new workspace JWT alongside the rotated Supabase
 *     refresh token so the client can update its Keychain entry.
 *
 * Body: { supabase_refresh_token, workspace_id? }
 *
 * Response:
 *  {
 *    token, expires_at, workspace,
 *    supabase_refresh_token: "<rotated>"
 *  }
 *
 * Errors:
 *  - 400 invalid_request — body validation failed.
 *  - 401 invalid_refresh_token — Supabase rejected the refresh token.
 *  - 503 not_configured — SUPABASE_ANON_KEY missing.
 *  - Plus the standard 401/403/404/500 cases from the shared helper.
 */
authRoutes.post(
  '/refresh',
  zValidator('json', refreshBodySchema, (result, c) => {
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
    const { supabase_refresh_token, workspace_id } = c.req.valid('json')
    const requestId = c.get('requestId')
    const env = getConfig()

    let anonKey: string
    try {
      anonKey = requireEnv('SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY)
    } catch {
      logger.error(
        { requestId },
        'auth/refresh: SUPABASE_ANON_KEY not configured',
      )
      return c.json({ error: 'not_configured' }, 503)
    }

    // 1. Refresh the Supabase session.
    const refreshUrl = `${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`
    let refreshResp: Response
    try {
      refreshResp = await fetch(refreshUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
        },
        body: JSON.stringify({ refresh_token: supabase_refresh_token }),
      })
    } catch (err) {
      logger.error(
        { requestId, err: err instanceof Error ? err.message : String(err) },
        'auth/refresh: supabase refresh fetch failed',
      )
      return c.json({ error: 'internal_error' }, 500)
    }

    if (refreshResp.status === 400 || refreshResp.status === 401) {
      return c.json({ error: 'invalid_refresh_token' }, 401)
    }
    if (!refreshResp.ok) {
      logger.error(
        { requestId, status: refreshResp.status },
        'auth/refresh: supabase refresh returned non-ok',
      )
      return c.json({ error: 'internal_error' }, 500)
    }

    let refreshJson: { access_token?: string; refresh_token?: string }
    try {
      refreshJson = (await refreshResp.json()) as {
        access_token?: string
        refresh_token?: string
      }
    } catch (err) {
      logger.error(
        { requestId, err: err instanceof Error ? err.message : String(err) },
        'auth/refresh: supabase refresh response not JSON',
      )
      return c.json({ error: 'internal_error' }, 500)
    }

    if (!refreshJson.access_token || !refreshJson.refresh_token) {
      return c.json({ error: 'invalid_refresh_token' }, 401)
    }

    // 2. Re-mint the workspace JWT using the new access token.
    const minted = await mintWorkspaceTokenForAccessToken({
      supabaseAccessToken: refreshJson.access_token,
      workspaceId: workspace_id,
      requestId,
    })
    if (!minted.ok) {
      return c.json(minted.body, minted.status)
    }

    return c.json(
      {
        ...minted.body,
        supabase_refresh_token: refreshJson.refresh_token,
      },
      200,
    )
  },
)

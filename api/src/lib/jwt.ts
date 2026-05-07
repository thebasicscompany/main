import { SignJWT, jwtVerify } from 'jose'
import { getConfig } from '../config.js'
import { AuthError, requireEnv } from './errors.js'

const ALGORITHM = 'HS256'
const EXPIRY_SECONDS = 24 * 60 * 60

/**
 * Workspace plan tiers carried in the JWT claims.
 */
export type WorkspacePlan = 'free' | 'pro' | 'enterprise'

/**
 * Workspace JWT payload — a 24h HS256 token issued by /v1/auth/token and
 * verified by `requireWorkspaceJwt`. All fields are strings (ISO 8601 for
 * timestamps) for JWT-safety.
 */
export interface WorkspaceToken {
  workspace_id: string
  account_id: string
  plan: WorkspacePlan
  seat_status: string
  issued_at: string
  expires_at: string
}

function secretKey(): Uint8Array {
  const env = getConfig()
  const secret = requireEnv('WORKSPACE_JWT_SECRET', env.WORKSPACE_JWT_SECRET)
  return new TextEncoder().encode(secret)
}

/**
 * Sign a short-lived workspace JWT (HS256, 24h expiry).
 */
export async function signWorkspaceToken(payload: WorkspaceToken): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt(now)
    .setExpirationTime(now + EXPIRY_SECONDS)
    .sign(secretKey())
}

/**
 * Verify a workspace JWT. Throws AuthError on any failure.
 *
 * NOTE: This is purely cryptographic verification + claim shape. DB-backed
 * membership / subscription checks are NOT performed here — they land
 * later when runtime tables exist.
 */
export async function verifyWorkspaceToken(token: string): Promise<WorkspaceToken> {
  if (!token || token.trim().length === 0) {
    throw new AuthError('Missing workspace token')
  }
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: [ALGORITHM],
    })
    const required = [
      'workspace_id',
      'account_id',
      'plan',
      'seat_status',
      'issued_at',
      'expires_at',
    ] as const
    for (const key of required) {
      if (typeof payload[key] !== 'string') {
        throw new AuthError(`Invalid workspace token: missing ${key}`)
      }
    }
    return {
      workspace_id: payload.workspace_id as string,
      account_id: payload.account_id as string,
      plan: payload.plan as WorkspacePlan,
      seat_status: payload.seat_status as string,
      issued_at: payload.issued_at as string,
      expires_at: payload.expires_at as string,
    }
  } catch (err) {
    if (err instanceof AuthError) throw err
    const message = err instanceof Error ? err.message : 'invalid token'
    throw new AuthError(`Invalid workspace token: ${message}`)
  }
}

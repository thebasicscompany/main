import { SignJWT } from 'jose'

const secret = process.env.WORKSPACE_JWT_SECRET
if (!secret) throw new Error('WORKSPACE_JWT_SECRET not set')

const enc = new TextEncoder().encode(secret)
const now = Math.floor(Date.now() / 1000)
const ttl = 24 * 60 * 60
const iso = (t) => new Date(t * 1000).toISOString()

const tok = await new SignJWT({
  workspace_id: process.env.WS_ID ?? '139e7cdc-7060-49c8-a04f-2afffddbd708',
  account_id: process.env.ACC_ID ?? 'aa9dd140-def8-4e8e-9955-4acc04e11fea',
  plan: 'pro',
  seat_status: 'active',
  issued_at: iso(now),
  expires_at: iso(now + ttl),
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt(now)
  .setExpirationTime(now + ttl)
  .sign(enc)

console.log(tok)

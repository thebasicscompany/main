// Mint a 24h workspace JWT for e2e probes.
// Run from repo root: doppler run --project backend --config dev -- node docs/.build-loop/artifacts/phase1-rename/sign-jwt.mjs
const { SignJWT } = await import('file:///C:/Users/Hello/Basics_App/main/node_modules/.pnpm/jose@6.2.3/node_modules/jose/dist/webapi/index.js')

const WORKSPACE_ID = '139e7cdc-7060-49c8-a04f-2afffddbd708'
const ACCOUNT_ID = 'aa9dd140-def8-4e8e-9955-4acc04e11fea'

const secret = process.env.WORKSPACE_JWT_SECRET
if (!secret) { console.error('WORKSPACE_JWT_SECRET missing'); process.exit(1) }

const now = Math.floor(Date.now() / 1000)
const exp = now + 24 * 60 * 60
const token = await new SignJWT({
  workspace_id: WORKSPACE_ID,
  account_id: ACCOUNT_ID,
  plan: 'pro',
  seat_status: 'active',
  issued_at: new Date(now * 1000).toISOString(),
  expires_at: new Date(exp * 1000).toISOString(),
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt(now)
  .setExpirationTime(exp)
  .sign(new TextEncoder().encode(secret))
console.log(token)

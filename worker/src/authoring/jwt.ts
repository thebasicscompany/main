// E.9 — Tiny HS256 signer for worker → api workspace-JWT calls.
//
// The worker container has WORKSPACE_JWT_SECRET in env (sst.config.ts
// E.9 addition). The two authoring tools (`propose_automation` +
// `activate_automation`) mint a short-lived JWT scoped to the run's
// own workspace + account and POST it to api.trybasics.ai.
//
// We hand-roll HS256 here (instead of pulling in `jose`) because the
// worker package already keeps its dep list narrow and the signing
// shape that `api/src/lib/jwt.ts → verifyWorkspaceToken` accepts is
// well-known: HS256 with the payload fields { workspace_id, account_id,
// plan, seat_status, issued_at, expires_at, iat, exp }.

import { createHmac } from "node:crypto";

function b64url(bytes: Buffer | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface WorkerJwtClaims {
  workspaceId: string;
  accountId: string;
  /** Default 'pro' — matches the operator-grade token the loop uses. */
  plan?: "free" | "pro";
  /** TTL in seconds. Default 300 (5 min) — workers shouldn't hold long
   *  bearer tokens; per-call mint is cheap. */
  ttlSeconds?: number;
}

export function signWorkerWorkspaceJwt(
  secret: string,
  claims: WorkerJwtClaims,
): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = claims.ttlSeconds ?? 300;
  const payload = {
    workspace_id: claims.workspaceId,
    account_id: claims.accountId,
    plan: claims.plan ?? "pro",
    seat_status: "active",
    issued_at: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    expires_at: new Date((now + ttl) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    iat: now,
    exp: now + ttl,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput =
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

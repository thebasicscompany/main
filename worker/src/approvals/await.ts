// C.4 — Worker pause/resume on approval.
//
// awaitApproval():
//   (a) Generate a single-use access token, hash it for storage.
//   (b) INSERT an `approvals` row with status='pending', expires_at,
//       access_token_hash. The signed link in the SMS/email path
//       (C.6) carries the raw token; the API (C.5) verifies it by
//       hashing the inbound token and comparing.
//   (c) Emit an `approval_requested` activity event with a
//       PII-scrubbed args_preview (uses B.5 scrubPreview), the reason,
//       expires_at, and the raw access_token. SSE consumers can read
//       it and render the approval prompt.
//   (d) LISTEN on a per-approval Postgres channel (session mode,
//       :5432, NOT the transaction-mode :6543 pooler).
//   (e) Resolve when NOTIFY fires OR when wall-clock hits expires_at.
//   (f) Re-query `approvals` to fetch the final status, return one of
//       'approved' | 'denied' | 'expired'.
//
// The wrapper that calls awaitApproval (withApproval, separate file)
// turns the outcome into a tool result: approved → execute, denied →
// structured error, expired → throw RunPausedError so the worker can
// end the task cleanly and leave the run in `awaiting_approval` state.

import type postgres from "postgres";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scrubPreview } from "../composio/audit.js";
import type { WorkerToolContext } from "../tools/context.js";
import type { ToolApprovalDecision } from "@basics/shared";
import { loadApprovalChannel, notifyApproval, type NotifierDeps } from "./notifier.js";

export type ApprovalOutcome = "approved" | "denied" | "expired";

export class RunPausedError extends Error {
  readonly code = "run_paused_awaiting_approval";
  constructor(
    readonly approvalId: string,
    readonly toolName: string,
  ) {
    super(`run paused awaiting approval ${approvalId} (${toolName})`);
    this.name = "RunPausedError";
  }
}

export interface AwaitApprovalDeps {
  /**
   * Session-mode pg connection (Supavisor port :5432). Used for the
   * LISTEN side. Transaction-mode (:6543) drops LISTEN registrations
   * on each query — see feedback_supavisor_listen_session_mode.md.
   */
  sqlListen: ReturnType<typeof postgres>;
  /**
   * Transaction-mode pg connection (:6543) used for INSERTs/SELECTs.
   * The worker's existing quotaSql (idle 60s) is a good fit.
   */
  sqlTx: ReturnType<typeof postgres>;
  /** Test seam. */
  now?: () => number;
  /** C.6 — notification path. Defaults to live SES/Sendblue; tests inject. */
  notifier?: NotifierDeps;
}

export interface AwaitApprovalSpec {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  decision: ToolApprovalDecision;
}

const APPROVAL_TTL_DEFAULT_S = 4 * 60 * 60;

/** Stable JSON for hashing args. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function channelFor(approvalId: string): string {
  // Postgres channel names can't have hyphens.
  return `approval_${approvalId.replace(/-/g, "_")}`;
}

/**
 * The core await loop. Inserts a pending approval, listens on a
 * Postgres channel until NOTIFY (with re-query for final status) or
 * timeout (returns 'expired' — the pg_cron reaper flips the row too,
 * via the C.1 trigger that emits the activity event).
 */
export async function awaitApproval(
  ctx: WorkerToolContext,
  spec: AwaitApprovalSpec,
  deps: AwaitApprovalDeps,
): Promise<{ approvalId: string; outcome: ApprovalOutcome }> {
  const tokenRaw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(tokenRaw).digest("hex");
  const argsHash = createHash("sha256")
    .update(stableStringify(spec.args))
    .digest("hex");
  const argsPreview = scrubPreview(spec.args) as Record<string, unknown>;

  const ttlSec = spec.decision.expiresInSeconds ?? APPROVAL_TTL_DEFAULT_S;
  const nowMs = deps.now?.() ?? Date.now();
  const expiresAt = new Date(nowMs + ttlSec * 1000);
  const approvalId = randomUUID();
  const reason = spec.decision.reason ?? "(no reason supplied)";

  // (b) INSERT pending approval. Uses sql.json for jsonb columns
  // (see feedback_postgres_js_jsonb_use_sql_json.md).
  type JsonInput = Parameters<typeof deps.sqlTx.json>[0];
  await deps.sqlTx`
    INSERT INTO public.approvals (
      id, run_id, workspace_id, tool_name, tool_call_id,
      args_preview, args_hash, reason, status,
      expires_at, access_token_hash
    ) VALUES (
      ${approvalId},
      ${ctx.runId},
      ${ctx.workspaceId},
      ${spec.toolName},
      ${spec.toolCallId},
      ${deps.sqlTx.json(argsPreview as JsonInput)},
      ${argsHash},
      ${reason},
      'pending',
      ${expiresAt},
      ${tokenHash}
    )
  `;

  // (c) Emit the activity event. Include the raw token so a downstream
  // notifier (C.6) can mint the signed link without re-deriving it.
  await ctx.publish({
    type: "approval_requested",
    payload: {
      kind: "approval_requested",
      approval_id: approvalId,
      tool_name: spec.toolName,
      tool_call_id: spec.toolCallId,
      args_preview: argsPreview,
      reason,
      expires_at: expiresAt.toISOString(),
      access_token: tokenRaw,
    },
  });

  // C.6 — fire the unattended-approval notification (SMS/email signed link).
  // Fire-and-forget at the awaitApproval level — the LISTEN/timeout flow
  // doesn't depend on notification success. notifyApproval swallows its own
  // errors and emits `approval_notify_failed` on send failure.
  void loadApprovalChannel(deps.sqlTx, ctx.workspaceId)
    .then((channelCfg) =>
      notifyApproval(
        ctx,
        {
          approvalId,
          toolName: spec.toolName,
          reason,
          rawToken: tokenRaw,
          expiresAt,
        },
        channelCfg,
        deps.notifier ?? {},
      ),
    )
    .catch((e) => {
      console.error("notifier: dispatch failed", (e as Error).message);
    });

  // (d) + (e) LISTEN with wall-clock timeout.
  const channel = channelFor(approvalId);
  let resolve!: (v: ApprovalOutcome) => void;
  const done = new Promise<ApprovalOutcome>((r) => {
    resolve = r;
  });

  const subscription = await deps.sqlListen.listen(channel, async () => {
    const rows = await deps.sqlTx<Array<{ status: string }>>`
      SELECT status FROM public.approvals WHERE id = ${approvalId} LIMIT 1
    `;
    const s = rows[0]?.status;
    if (s === "approved" || s === "denied" || s === "expired") {
      resolve(s);
    }
  });

  const timeoutMs = Math.max(0, expiresAt.getTime() - nowMs);
  const timeoutHandle = setTimeout(() => resolve("expired"), timeoutMs);

  try {
    const outcome = await done;
    return { approvalId, outcome };
  } finally {
    clearTimeout(timeoutHandle);
    const unlisten = (subscription as unknown as { unlisten?: () => Promise<void> })
      .unlisten;
    if (typeof unlisten === "function") await unlisten().catch(() => undefined);
  }
}

// Re-exports for tests + the wrapper module.
export const _internals = { stableStringify, channelFor };

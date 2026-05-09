// Approval middleware for tools with `requiresApproval: true`.
// CLOUD-AGENT-PLAN §18 + BUILD-LOOP B.4. The worker inserts into
// `pending_approvals`, emits an `approval_required` event into
// agent_activity (so SSE clients render the prompt), polls the row
// until the api resolves it (POST /v1/runtime/runs/.../approvals/.../resolve),
// then emits `approval_resolved` and either runs the tool or returns
// an `error` ToolResult.

import postgres from "postgres";
import { randomUUID } from "node:crypto";

export type ApprovalDecision = "approve" | "reject" | "timeout";

export interface RequestApprovalInput {
  runId: string;
  workspaceId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
  preview?: string;
}

export interface RequestApprovalResult {
  approvalId: string;
  decision: ApprovalDecision;
  decidedBy: "user" | "auto" | "timeout";
}

export interface ApprovalGate {
  /** Block until the operator decides; throws on DB errors. */
  await(input: RequestApprovalInput): Promise<RequestApprovalResult>;
}

export interface PgApprovalGateOptions {
  databaseUrl: string;
  /** How often to re-check the pending_approvals row. Default 2s. */
  pollIntervalMs?: number;
  /** Wall-clock cap. Default 30 min — matches §18 default reject-on-timeout. */
  timeoutMs?: number;
}

interface PendingRow {
  decision: "approved" | "rejected" | null;
  resolved_at: Date | null;
}

export class PgApprovalGate implements ApprovalGate {
  private sql: ReturnType<typeof postgres>;
  private pollMs: number;
  private timeoutMs: number;

  constructor(opts: PgApprovalGateOptions) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
    this.pollMs = opts.pollIntervalMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  }

  async await(input: RequestApprovalInput): Promise<RequestApprovalResult> {
    const approvalId = randomUUID();
    const resumeToken = randomUUID();

    await this.sql`
      INSERT INTO public.pending_approvals
        (id, agent_run_id, workspace_id, action_name, payload, preview_text, resume_token, cancel_window_seconds)
      VALUES
        (${approvalId}, ${input.runId}, ${input.workspaceId},
         ${input.tool},
         ${this.sql.json(input.params as unknown as Parameters<typeof this.sql.json>[0])},
         ${input.preview ?? null},
         ${resumeToken}, 0)
    `;

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.sql<PendingRow[]>`
        SELECT decision, resolved_at
          FROM public.pending_approvals
         WHERE id = ${approvalId}
         LIMIT 1
      `;
      const row = rows[0];
      if (row && row.resolved_at !== null && row.decision !== null) {
        return {
          approvalId,
          decision: row.decision === "approved" ? "approve" : "reject",
          decidedBy: "user",
        };
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }

    // Timed out — mark the row so the operator UI shows it as expired.
    await this.sql`
      UPDATE public.pending_approvals
         SET decision = 'rejected', resolved_at = now(), decided_at = now()
       WHERE id = ${approvalId} AND resolved_at IS NULL
    `;
    return { approvalId, decision: "timeout", decidedBy: "timeout" };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** Test double — every approval auto-grants immediately. */
export class AutoApproveGate implements ApprovalGate {
  async await(_input: RequestApprovalInput): Promise<RequestApprovalResult> {
    return { approvalId: randomUUID(), decision: "approve", decidedBy: "auto" };
  }
}

/** Test double — every approval auto-rejects (used to assert the reject path). */
export class AutoRejectGate implements ApprovalGate {
  async await(_input: RequestApprovalInput): Promise<RequestApprovalResult> {
    return { approvalId: randomUUID(), decision: "reject", decidedBy: "auto" };
  }
}

// C.4 — Per-call approval wrapper used by the opencode-plugin's tool
// dispatch. Decides whether to gate, optionally short-circuits via
// matching approval_rules, and turns the awaitApproval outcome into
// either a tool result (approved/denied) or a RunPausedError (expired).

import type { ToolDefinition, ToolResult } from "@basics/shared";
import type { z, ZodTypeAny } from "zod";
import type { WorkerToolContext } from "../tools/context.js";
import { lookupApprovalRule } from "./policy.js";
import {
  awaitApproval,
  RunPausedError,
  type AwaitApprovalDeps,
  type ApprovalOutcome,
} from "./await.js";

export interface WithApprovalDeps extends AwaitApprovalDeps {
  /** SQL connection used for approval_rules lookup. Reuse sqlTx in prod. */
  sqlRules: ReturnType<typeof import("postgres")>;
}

/**
 * Run `def.execute(args, ctx)` with the approval gate inserted.
 *
 * Gate sequence:
 *   1) If def.approval is unset, fast-path: just execute.
 *   2) Call def.approval(args) → decision. If !decision.required, execute.
 *   3) Look up approval_rules — if a matching row exists, skip the gate.
 *   4) awaitApproval → outcome:
 *        approved → execute
 *        denied   → return { kind:'json', json:{ ok:false, error:{ code:'approval_denied' } } }
 *        expired  → emit `run_paused_awaiting_approval`, throw RunPausedError
 */
export async function executeWithApproval<P extends ZodTypeAny, R extends ToolResult>(
  def: ToolDefinition<P, WorkerToolContext, R>,
  toolCallId: string,
  args: z.infer<P>,
  ctx: WorkerToolContext,
  deps: WithApprovalDeps,
): Promise<R | { kind: "json"; json: { ok: false; error: { code: string; approvalId?: string } } }> {
  if (!def.approval) {
    return def.execute(args, ctx);
  }

  const decision = def.approval(args);
  if (!decision.required) {
    return def.execute(args, ctx);
  }

  // (3) approval_rules short-circuit.
  let ruleMatched = false;
  try {
    ruleMatched = await lookupApprovalRule(
      deps.sqlRules,
      ctx.workspaceId,
      def.name,
      args as Record<string, unknown>,
      ctx.automationId,
    );
  } catch (e) {
    // Rule lookup failure must NOT auto-approve — fall through to the gate.
    console.error("withApproval: approval_rules lookup failed", (e as Error).message);
  }
  if (ruleMatched) {
    return def.execute(args, ctx);
  }

  const { approvalId, outcome } = await awaitApproval(
    ctx,
    {
      toolName: def.name,
      toolCallId,
      args: args as Record<string, unknown>,
      decision,
    },
    deps,
  );

  switch (outcome as ApprovalOutcome) {
    case "approved":
      await ctx.publish({
        type: "approval_granted",
        payload: { kind: "approval_granted", approval_id: approvalId, tool_name: def.name },
      });
      return def.execute(args, ctx);
    case "denied":
      await ctx.publish({
        type: "approval_denied",
        payload: { kind: "approval_denied", approval_id: approvalId, tool_name: def.name },
      });
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: { code: "approval_denied", approvalId },
        },
      };
    case "expired":
    default:
      await ctx.publish({
        type: "run_paused_awaiting_approval",
        payload: {
          kind: "run_paused_awaiting_approval",
          approval_id: approvalId,
          tool_name: def.name,
        },
      });
      throw new RunPausedError(approvalId, def.name);
  }
}

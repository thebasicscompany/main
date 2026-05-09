import { defineTool } from "@basics/shared";
import { z } from "zod";
import { intersectTools } from "../subagent.js";
import type { WorkerToolContext } from "./context.js";

const DEFAULT_MAX_TURNS = 16;

export const spawn_subagent = defineTool({
  name: "spawn_subagent",
  description:
    "Spawn a sub-agent (inner opencode session) inside this run. The sub-agent inherits /workspace (read-only by default; pass writable:true to mutate), gets its own browser tab, and only sees the tools you list in `allowedTools`. Returns the sub-agent's transcript + final answer when it terminates (final_answer) or hits maxTurns.",
  params: z.object({
    goal: z.string().min(1).max(2000),
    allowedTools: z.array(z.string().min(1)).min(1).max(40),
    maxTurns: z.number().int().min(1).max(64).optional(),
    writable: z.boolean().optional(),
  }),
  // Sub-agent spawn IS a control-plane mutation (creates a nested run);
  // gate via approval so operators see what's being delegated.
  mutating: true,
  requiresApproval: true,
  cost: "high",
  execute: async (
    { goal, allowedTools, maxTurns, writable },
    ctx: WorkerToolContext,
  ) => {
    if (!ctx.subagentRunner) {
      throw new Error("subagent_unavailable: ctx.subagentRunner is not configured for this run");
    }

    // Intersect requested tools with what's actually registered. If a
    // parent asks for tools we don't ship, drop them silently — the
    // subagent's opencode session just won't see them.
    if (!ctx.toolRegistryNames || ctx.toolRegistryNames.length === 0) {
      throw new Error("subagent_unavailable: ctx.toolRegistryNames is required to filter tools");
    }
    const filtered = intersectTools(ctx.toolRegistryNames, allowedTools);
    if (filtered.length === 0) {
      throw new Error(
        `subagent_no_tools: none of the requested tools [${allowedTools.join(", ")}] are registered`,
      );
    }

    await ctx.publish({
      type: "subagent_started",
      payload: {
        goal,
        allowedTools: filtered,
        maxTurns: maxTurns ?? DEFAULT_MAX_TURNS,
        writable: writable ?? false,
      },
    });

    const result = await ctx.subagentRunner.run({
      goal,
      allowedTools: filtered,
      maxTurns: maxTurns ?? DEFAULT_MAX_TURNS,
      writable: writable ?? false,
      parentRunId: ctx.runId,
      workspaceId: ctx.workspaceId,
    });

    await ctx.publish({
      type: "subagent_finished",
      payload: {
        stopReason: result.stopReason,
        turnsUsed: result.turnsUsed,
        finalAnswer: result.finalAnswer,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    });

    return {
      kind: "json",
      json: {
        finalAnswer: result.finalAnswer,
        stopReason: result.stopReason,
        turnsUsed: result.turnsUsed,
        transcript: result.transcript,
      },
    };
  },
});

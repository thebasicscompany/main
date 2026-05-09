import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const set_step_status = defineTool({
  name: "set_step_status",
  description:
    "Mark one plan step's status. `status` is one of pending|in_progress|completed|skipped|failed. Optional `note` carries a short reason (visible to the operator).",
  params: z.object({
    stepId: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed", "skipped", "failed"]),
    note: z.string().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ stepId, status, note }, ctx: WorkerToolContext) => {
    await ctx.publish({
      type: "step_status",
      payload: { stepId, status, ...(note ? { note } : {}) },
    });
    return { kind: "json", json: { stepId, status } };
  },
});

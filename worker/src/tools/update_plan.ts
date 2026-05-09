import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

const PlanStatus = z.enum(["pending", "in_progress", "completed", "skipped", "failed"]);

const PlanStep = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: PlanStatus.optional(),
});

export const update_plan = defineTool({
  name: "update_plan",
  description:
    "Replace the current plan with a fresh list of steps. Each step has an id, title, and optional description / status. Use at the start of a non-trivial task and whenever the plan needs revision.",
  params: z.object({
    steps: z.array(PlanStep).min(1).max(50),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ steps }, ctx: WorkerToolContext) => {
    await ctx.publish({
      type: "plan_updated",
      payload: { steps },
    });
    return { kind: "json", json: { steps: steps.length } };
  },
});

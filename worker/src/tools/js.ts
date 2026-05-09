import { defineTool } from "@basics/shared";
import { js as harnessJs } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const js = defineTool({
  name: "js",
  description:
    "Evaluate a JavaScript expression in the active tab's main frame and return its value (JSON-serialized). Use for DOM reads — not for mutating click flows.",
  params: z.object({
    expression: z.string().min(1),
    targetId: z.string().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ expression, targetId }, ctx: WorkerToolContext) => {
    const result = await harnessJs(ctx.session, expression, { targetId });
    // Runner owns the tool_call_start/end timeline.
    return { kind: "json", json: result };
  },
});

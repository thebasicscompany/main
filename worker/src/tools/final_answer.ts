import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const final_answer = defineTool({
  name: "final_answer",
  description:
    "Emit the run's final answer / summary. The runner converts this into the run_completed event's `summary` field; calling it signals the model is done.",
  params: z.object({
    text: z.string().min(1).max(20_000),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ text }, ctx: WorkerToolContext) => {
    await ctx.publish({
      type: "final_answer",
      payload: { text },
    });
    return { kind: "text", text: "ok" };
  },
});

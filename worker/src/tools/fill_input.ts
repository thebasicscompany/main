import { defineTool } from "@basics/shared";
import { fill_input as harnessFillInput } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const fill_input = defineTool({
  name: "fill_input",
  description: "Focus, optionally clear, then type into a framework-managed input (React controlled, Vue v-model, Ember tracked).",
  params: z.object({
    selector: z.string().min(1),
    text: z.string(),
    clearFirst: z.boolean().optional(),
    timeout: z.number().nonnegative().optional(),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ selector, text, clearFirst, timeout }, ctx: WorkerToolContext) => {
    await harnessFillInput(ctx.session, selector, text, clearFirst ?? true, timeout ?? 0);
    return { kind: "text", text: `filled ${selector} with ${text.length} chars` };
  },
});

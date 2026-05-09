import { defineTool } from "@basics/shared";
import { type_text as harnessTypeText } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const type_text = defineTool({
  name: "type_text",
  description: "Type literal text into the focused element via Input.insertText. Use fill_input for framework-managed inputs (React/Vue/Ember).",
  params: z.object({ text: z.string() }),
  mutating: true,
  cost: "low",
  execute: async ({ text }, ctx: WorkerToolContext) => {
    await harnessTypeText(ctx.session, text);
    return { kind: "text", text: `typed ${text.length} chars` };
  },
});

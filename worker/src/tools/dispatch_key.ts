import { defineTool } from "@basics/shared";
import { dispatch_key as harnessDispatchKey } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const dispatch_key = defineTool({
  name: "dispatch_key",
  description: "Synthesize a DOM keyboard event on a specific selector (default 'Enter' on 'keypress'). Useful for triggering framework listeners that ignore CDP-level keys.",
  params: z.object({
    selector: z.string().min(1),
    key: z.string().min(1).optional(),
    event: z.enum(["keydown", "keypress", "keyup"]).optional(),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ selector, key, event }, ctx: WorkerToolContext) => {
    await harnessDispatchKey(ctx.session, selector, key ?? "Enter", event ?? "keypress");
    return { kind: "text", text: `dispatched ${event ?? "keypress"}:${key ?? "Enter"} on ${selector}` };
  },
});

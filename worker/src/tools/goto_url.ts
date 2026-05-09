import { defineTool } from "@basics/shared";
import { goto_url as harnessGotoUrl } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const goto_url = defineTool({
  name: "goto_url",
  description:
    "Navigate the active tab to a URL. Returns the navigation result (frame id, etc.).",
  params: z.object({
    url: z.string().url(),
  }),
  // Navigation is information-class for approvals — it doesn't write
  // tenant data. Click / type / fill_input are the mutating ones.
  mutating: false,
  cost: "low",
  execute: async ({ url }, ctx: WorkerToolContext) => {
    const result = await harnessGotoUrl(ctx.session, url);
    // Runner owns the tool_call_start/end timeline.
    return { kind: "json", json: result };
  },
});

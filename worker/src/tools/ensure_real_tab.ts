import { defineTool } from "@basics/shared";
import { ensure_real_tab as harnessEnsureRealTab } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const ensure_real_tab = defineTool({
  name: "ensure_real_tab",
  description: "Re-attach to a real (non-internal) tab if the current target is stale or chrome://. Returns the resolved tab info or null.",
  params: z.object({}),
  mutating: false,
  cost: "low",
  execute: async (_a, ctx: WorkerToolContext) => {
    const tab = await harnessEnsureRealTab(ctx.session);
    return { kind: "json", json: { tab: tab ?? null } };
  },
});

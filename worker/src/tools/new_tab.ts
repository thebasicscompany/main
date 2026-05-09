import { defineTool } from "@basics/shared";
import { new_tab as harnessNewTab } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const new_tab = defineTool({
  name: "new_tab",
  description: "Open a new tab and (optionally) navigate to a URL. Returns the new tab's targetId.",
  params: z.object({ url: z.string().url().optional() }),
  mutating: false,
  cost: "low",
  execute: async ({ url }, ctx: WorkerToolContext) => {
    const targetId = await harnessNewTab(ctx.session, url ?? "about:blank");
    return { kind: "json", json: { targetId } };
  },
});

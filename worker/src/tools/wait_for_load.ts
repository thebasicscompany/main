import { defineTool } from "@basics/shared";
import { wait_for_load as harnessWaitForLoad } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const wait_for_load = defineTool({
  name: "wait_for_load",
  description: "Block until document.readyState === 'complete' or `timeout` seconds pass. Returns true on load, false on timeout.",
  params: z.object({ timeout: z.number().positive().optional() }),
  mutating: false,
  cost: "low",
  execute: async ({ timeout }, ctx: WorkerToolContext) => {
    const ok = await harnessWaitForLoad(ctx.session, timeout ?? 15);
    return { kind: "json", json: { loaded: ok } };
  },
});

import { defineTool } from "@basics/shared";
import { wait_for_network_idle as harnessWaitForNetworkIdle } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const wait_for_network_idle = defineTool({
  name: "wait_for_network_idle",
  description: "Block until the page has had no network activity for `idleMs` consecutive milliseconds (or `timeout` seconds elapse). Returns true on idle.",
  params: z.object({
    timeout: z.number().positive().optional(),
    idleMs: z.number().positive().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ timeout, idleMs }, ctx: WorkerToolContext) => {
    const ok = await harnessWaitForNetworkIdle(
      ctx.session,
      timeout ?? 10,
      idleMs ?? 500,
    );
    return { kind: "json", json: { idle: ok } };
  },
});

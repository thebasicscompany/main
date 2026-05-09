import { defineTool } from "@basics/shared";
import { wait_for_element as harnessWaitForElement } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const wait_for_element = defineTool({
  name: "wait_for_element",
  description: "Poll until a CSS selector matches (and optionally is visible) or `timeout` seconds pass. Returns true if matched.",
  params: z.object({
    selector: z.string().min(1),
    timeout: z.number().positive().optional(),
    visible: z.boolean().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ selector, timeout, visible }, ctx: WorkerToolContext) => {
    const ok = await harnessWaitForElement(
      ctx.session,
      selector,
      timeout ?? 10,
      visible ?? false,
    );
    return { kind: "json", json: { found: ok } };
  },
});

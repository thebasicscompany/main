import { defineTool } from "@basics/shared";
import { scroll as harnessScroll } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const scroll = defineTool({
  name: "scroll",
  description: "Synthesize a mouse-wheel event at (x, y) with delta (dx, dy). Negative dy scrolls down (default -300).",
  params: z.object({
    x: z.number().int(),
    y: z.number().int(),
    dy: z.number().int().optional(),
    dx: z.number().int().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ x, y, dy, dx }, ctx: WorkerToolContext) => {
    await harnessScroll(ctx.session, x, y, dy ?? -300, dx ?? 0);
    return { kind: "text", text: `scrolled at (${x}, ${y}) by (${dx ?? 0}, ${dy ?? -300})` };
  },
});

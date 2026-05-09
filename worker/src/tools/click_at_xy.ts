import { defineTool } from "@basics/shared";
import { click_at_xy as harnessClick } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const click_at_xy = defineTool({
  name: "click_at_xy",
  description: "Dispatch a mouse click at viewport (x, y). Coordinate clicks pass through iframes / shadow DOM at the compositor level.",
  params: z.object({
    x: z.number().int(),
    y: z.number().int(),
    button: z.enum(["left", "middle", "right"]).optional(),
    clicks: z.number().int().min(1).max(3).optional(),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ x, y, button, clicks }, ctx: WorkerToolContext) => {
    await harnessClick(ctx.session, x, y, button ?? "left", clicks ?? 1);
    return { kind: "text", text: `clicked (${x}, ${y})` };
  },
});

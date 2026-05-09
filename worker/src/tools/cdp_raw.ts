import { defineTool } from "@basics/shared";
import { cdp } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const cdp_raw = defineTool({
  name: "cdp_raw",
  description:
    "Escape hatch — issue an arbitrary Chrome DevTools Protocol command (e.g. 'Page.getNavigationHistory', 'Network.enable'). Use only when no purpose-built tool fits; the model should prefer typed wrappers.",
  params: z.object({
    method: z
      .string()
      .min(1)
      .regex(/^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]+$/, "method must look like 'Domain.command'"),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  // Power tool — gate by default. Caller can grant via the approval flow
  // (slice 4 / Phase B.4) or pre-approve in workspace settings.
  mutating: true,
  requiresApproval: true,
  cost: "low",
  execute: async ({ method, params }, ctx: WorkerToolContext) => {
    const result = await cdp(ctx.session, method, (params ?? {}) as Record<string, unknown>);
    return { kind: "json", json: result };
  },
});

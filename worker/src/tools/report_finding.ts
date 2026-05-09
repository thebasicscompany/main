import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const report_finding = defineTool({
  name: "report_finding",
  description:
    "Record a structured finding the operator should see — `kind: evidence` (a fact you've verified), `note` (a side observation), or `risk` (something the operator should consider before resuming).",
  params: z.object({
    kind: z.enum(["evidence", "note", "risk"]),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ kind, title, body }, ctx: WorkerToolContext) => {
    await ctx.publish({
      type: "finding",
      payload: { kind, title, body },
    });
    return { kind: "json", json: { kind, title } };
  },
});

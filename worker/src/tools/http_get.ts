import { defineTool } from "@basics/shared";
import { http_get as harnessHttpGet } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const http_get = defineTool({
  name: "http_get",
  description: "GET a URL via the worker's egress (no browser involvement). Use for static pages — bulk HTTP that doesn't need rendering.",
  params: z.object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().positive().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ url, headers, timeout }, _ctx: WorkerToolContext) => {
    const r = await harnessHttpGet(url, headers, timeout ?? 20);
    return { kind: "json", json: r as unknown as Record<string, unknown> };
  },
});

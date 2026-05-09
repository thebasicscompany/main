import { defineTool } from "@basics/shared";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { realpathInsideWorkspace } from "./fs-policy.js";
import type { WorkerToolContext } from "./context.js";

export const read_file = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file under /workspace. Returns the full content. Path must be relative to /workspace; absolute or `..`-escaping paths reject.",
  params: z.object({
    path: z.string().min(1),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ path: relPath }, ctx: WorkerToolContext) => {
    const abs = await realpathInsideWorkspace(ctx.workspaceRoot, relPath);
    const content = await fs.readFile(abs, "utf8");
    return { kind: "json", json: { path: relPath, content, byteLength: Buffer.byteLength(content) } };
  },
});

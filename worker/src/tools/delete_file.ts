import { defineTool } from "@basics/shared";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { realpathInsideWorkspace } from "./fs-policy.js";
import type { WorkerToolContext } from "./context.js";

export const delete_file = defineTool({
  name: "delete_file",
  description:
    "Delete a single file under /workspace. Refuses to delete directories — use multiple delete_file calls or the workspace janitor for that.",
  params: z.object({
    path: z.string().min(1),
  }),
  mutating: true,
  // Mutating + dangerous; gate on approval by default.
  requiresApproval: true,
  cost: "low",
  execute: async ({ path: relPath }, ctx: WorkerToolContext) => {
    const abs = await realpathInsideWorkspace(ctx.workspaceRoot, relPath);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      throw new Error(`is_directory: ${relPath}; delete_file refuses directories`);
    }
    await fs.unlink(abs);
    return { kind: "json", json: { path: relPath, deleted: true } };
  },
});

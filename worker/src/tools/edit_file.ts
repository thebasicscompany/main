import { defineTool } from "@basics/shared";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { realpathInsideWorkspace } from "./fs-policy.js";
import type { WorkerToolContext } from "./context.js";

export const edit_file = defineTool({
  name: "edit_file",
  description:
    "Replace `oldString` with `newString` in a UTF-8 file under /workspace. Fails if `oldString` doesn't appear or appears more than once (set replaceAll: true to allow multiple).",
  params: z.object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ path: relPath, oldString, newString, replaceAll }, ctx: WorkerToolContext) => {
    const abs = await realpathInsideWorkspace(ctx.workspaceRoot, relPath);
    const before = await fs.readFile(abs, "utf8");
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`old_string_not_found: ${relPath}`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string_ambiguous: ${relPath} contains ${occurrences} matches; pass replaceAll: true to allow`,
      );
    }
    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    await fs.writeFile(abs, after, "utf8");
    return { kind: "json", json: { path: relPath, replacements: replaceAll ? occurrences : 1 } };
  },
});

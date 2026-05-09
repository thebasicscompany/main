import { defineTool } from "@basics/shared";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { realpathInsideWorkspace } from "./fs-policy.js";
import {
  validateSkillWrite,
  pathRequiresSkillWritePolicy,
  SkillWriteBlockedError,
} from "../middleware/skill-write-policy.js";
import type { WorkerToolContext } from "./context.js";

export const write_file = defineTool({
  name: "write_file",
  description:
    "Write a UTF-8 text file under /workspace. Creates parent directories. By default refuses to overwrite an existing file (set overwrite: true to replace).",
  params: z.object({
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().optional(),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ path: relPath, content, overwrite }, ctx: WorkerToolContext) => {
    if (pathRequiresSkillWritePolicy(relPath)) {
      const verdict = validateSkillWrite(relPath, content);
      if (!verdict.ok) {
        await ctx.publish({
          type: "skill_write_blocked",
          payload: {
            path: relPath,
            code: verdict.code,
            message: verdict.message,
            byteLength: Buffer.byteLength(content, "utf8"),
          },
        });
        throw new SkillWriteBlockedError(verdict);
      }
    }
    const abs = await realpathInsideWorkspace(ctx.workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (!overwrite) {
      try {
        await fs.access(abs);
        throw new Error(`file_exists: ${relPath}; pass overwrite: true to replace`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    await fs.writeFile(abs, content, "utf8");
    return { kind: "json", json: { path: relPath, byteLength: Buffer.byteLength(content) } };
  },
});

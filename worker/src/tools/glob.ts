import { defineTool } from "@basics/shared";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { resolveInsideWorkspace } from "./fs-policy.js";
import type { WorkerToolContext } from "./context.js";

/** Convert a shell glob pattern to a regex. Handles `*`, `**`, `?`, literals. */
function globToRegExp(glob: string): RegExp {
  const parts = glob.split("/");
  const segs = parts.map((p) => {
    if (p === "**") return "(?:.*)";
    return p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
  });
  return new RegExp("^" + segs.join("/") + "$");
}

async function walk(root: string, sub: string, out: string[], cap: number): Promise<void> {
  if (out.length >= cap) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(root, sub), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(root, rel, out, cap);
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push(rel);
    }
  }
}

export const glob = defineTool({
  name: "glob",
  description:
    "List files under /workspace whose path matches a shell glob (`*`, `**`, `?`). Always relative to the workspace root. Default cap 500.",
  params: z.object({
    pattern: z.string().min(1),
    limit: z.number().int().positive().max(5000).optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ pattern, limit }, ctx: WorkerToolContext) => {
    // Verify the implied root is in-sandbox (always is, since we walk from
    // workspaceRoot itself; this also catches misconfigured ctx).
    resolveInsideWorkspace(ctx.workspaceRoot, ".");
    const cap = limit ?? 500;
    const out: string[] = [];
    await walk(ctx.workspaceRoot, "", out, cap * 5);
    const re = globToRegExp(pattern);
    const matched = out.filter((p) => re.test(p)).slice(0, cap);
    return { kind: "json", json: { pattern, matches: matched, count: matched.length } };
  },
});

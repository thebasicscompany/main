import { defineTool } from "@basics/shared";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { resolveInsideWorkspace } from "./fs-policy.js";
import type { WorkerToolContext } from "./context.js";

interface GrepHit {
  path: string;
  line: number;
  text: string;
}

async function* walkFiles(
  root: string,
  sub: string,
): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(root, sub), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* walkFiles(root, rel);
    } else if (e.isFile()) {
      yield rel;
    }
  }
}

export const grep = defineTool({
  name: "grep",
  description:
    "Search files under /workspace for a literal string (or regex when `regex: true`). Returns up to `limit` hits with line numbers. Skips binary files heuristically.",
  params: z.object({
    pattern: z.string().min(1),
    glob: z.string().optional(),
    regex: z.boolean().optional(),
    flags: z.string().regex(/^[gimsuy]*$/).optional(),
    limit: z.number().int().positive().max(2000).optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ pattern, glob: globPattern, regex, flags, limit }, ctx: WorkerToolContext) => {
    resolveInsideWorkspace(ctx.workspaceRoot, ".");
    const cap = limit ?? 500;
    const re = regex
      ? new RegExp(pattern, flags ?? "")
      : null;
    const literal = regex ? null : pattern;
    const hits: GrepHit[] = [];
    let scanned = 0;

    let pathRe: RegExp | null = null;
    if (globPattern) {
      const parts = globPattern.split("/").map((p) => {
        if (p === "**") return "(?:.*)";
        return p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]");
      });
      pathRe = new RegExp("^" + parts.join("/") + "$");
    }

    for await (const rel of walkFiles(ctx.workspaceRoot, "")) {
      if (hits.length >= cap) break;
      if (pathRe && !pathRe.test(rel)) continue;
      scanned++;
      let content: string;
      try {
        content = await fs.readFile(path.join(ctx.workspaceRoot, rel), "utf8");
      } catch {
        continue;
      }
      // Crude binary heuristic: skip if first 1KB has > 1% null bytes.
      const head = content.slice(0, 1024);
      let nulls = 0;
      for (let i = 0; i < head.length; i++) if (head.charCodeAt(i) === 0) nulls++;
      if (nulls / Math.max(1, head.length) > 0.01) continue;

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= cap) break;
        const line = lines[i] ?? "";
        const matched = re ? re.test(line) : line.includes(literal!);
        if (matched) hits.push({ path: rel, line: i + 1, text: line });
        if (re && !flags?.includes("g")) {
          // Reset lastIndex when re has the 'g' flag is the only stateful case.
        }
      }
    }
    return { kind: "json", json: { hits, count: hits.length, filesScanned: scanned } };
  },
});

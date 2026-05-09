// Sandbox enforcement for the filesystem tools. CLOUD-AGENT-PLAN §3.2 +
// §22: every fs read/write must resolve INSIDE the workspace root. Any
// `..` traversal, absolute path outside, or symlink escape rejects with
// `path_outside_sandbox`.

import * as path from "node:path";
import * as fs from "node:fs/promises";

export class PathOutsideSandboxError extends Error {
  constructor(public readonly attempted: string, public readonly root: string) {
    super(`path_outside_sandbox: ${attempted} not under ${root}`);
    this.name = "PathOutsideSandboxError";
  }
}

/**
 * Resolve a caller-supplied path against the workspace root. Rejects:
 *   - Absolute paths (must be relative to /workspace)
 *   - Paths whose normalized form escapes the root via `..`
 *   - Symlinks that resolve outside the root (caller's responsibility to
 *     re-check after open if they accept the resolved string)
 */
export function resolveInsideWorkspace(workspaceRoot: string, input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathOutsideSandboxError(String(input), workspaceRoot);
  }
  if (path.isAbsolute(input)) {
    throw new PathOutsideSandboxError(input, workspaceRoot);
  }
  const normRoot = path.resolve(workspaceRoot);
  const normPath = path.resolve(normRoot, input);
  if (normPath !== normRoot && !normPath.startsWith(normRoot + path.sep)) {
    throw new PathOutsideSandboxError(input, workspaceRoot);
  }
  return normPath;
}

/** Async variant that also resolves symlinks via realpath. */
export async function realpathInsideWorkspace(
  workspaceRoot: string,
  input: string,
): Promise<string> {
  const resolved = resolveInsideWorkspace(workspaceRoot, input);
  try {
    const real = await fs.realpath(resolved);
    const realRoot = await fs.realpath(path.resolve(workspaceRoot));
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new PathOutsideSandboxError(input, workspaceRoot);
    }
    return real;
  } catch (err) {
    // ENOENT means the file doesn't exist yet — that's fine for
    // write_file. Surface other errors unchanged.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw err;
  }
}

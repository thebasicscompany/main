// `bash` tool — execute arbitrary shell commands inside a sandbox.
// CLOUD-AGENT-PLAN §22: filesystem-restricted via bubblewrap, with the
// workspace EFS subtree mounted read-write and everything else hidden
// or read-only. Network allow-list (curl evil.example.com → blocked,
// curl api.anthropic.com → allowed) requires a worker-side HTTP proxy
// — that is deferred to a follow-up step; for now the bash tool relies
// on the worker task's egress SG, which is broad. This is documented
// in state.json deviations.

import { spawn } from "node:child_process";
import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

interface SandboxArgsOptions {
  workspaceRoot: string;
  cmd: string;
  timeoutSeconds: number;
  bwrapAvailable: boolean;
}

/**
 * Build the argv that runs `cmd` inside a bwrap sandbox. Exposed for
 * tests so we can assert the isolation flags are present without
 * actually spawning a process.
 */
export function buildSandboxArgs(opts: SandboxArgsOptions): { command: string; args: string[] } {
  if (opts.bwrapAvailable) {
    return {
      command: "bwrap",
      args: [
        // New PID + user + IPC + UTS + cgroup namespaces
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        // Read-only system mounts — gives bash access to /bin/sh, /usr, /lib, /lib64
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/sbin", "/sbin",
        "--ro-bind-try", "/etc/ssl", "/etc/ssl",
        "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
        // Workspace is the only writable mount.
        "--bind", opts.workspaceRoot, "/workspace",
        // Empty /etc, /var, /tmp — caller can't `cat /etc/passwd`.
        "--tmpfs", "/etc",
        "--tmpfs", "/var",
        "--tmpfs", "/tmp",
        "--proc", "/proc",
        "--dev", "/dev",
        // CWD inside the sandbox.
        "--chdir", "/workspace",
        // Drop all caps; new session keeps signal isolation.
        "--cap-drop", "ALL",
        "--die-with-parent",
        "--",
        "/bin/sh", "-c", opts.cmd,
      ],
    };
  }
  // Fallback: still chdir to workspaceRoot. No isolation. Logged at
  // boot; callers can detect via the bash result's `sandbox` field.
  return { command: "/bin/sh", args: ["-c", opts.cmd] };
}

const BWRAP_AVAILABLE = (() => {
  if (process.env.BWRAP_AVAILABLE === "1") return true;
  if (process.env.BWRAP_AVAILABLE === "0") return false;
  // Default: not available (test default; Dockerfile sets BWRAP_AVAILABLE=1).
  return false;
})();

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  sandbox: "bwrap" | "none";
  truncated: boolean;
}

const STDOUT_CAP = 1024 * 1024; // 1 MiB
const STDERR_CAP = 256 * 1024;  // 256 KiB

export const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command. Filesystem is restricted to /workspace via bubblewrap; everything else is read-only or hidden. Default 30s timeout; max 120s. stdout capped at 1 MiB.",
  params: z.object({
    cmd: z.string().min(1).max(10_000),
    timeoutSeconds: z.number().int().positive().max(120).optional(),
  }),
  mutating: true,
  // Power tool — gate on approval until §18 wires per-call decisions.
  requiresApproval: true,
  cost: "medium",
  execute: async ({ cmd, timeoutSeconds }, ctx: WorkerToolContext) => {
    const t = timeoutSeconds ?? 30;
    const { command, args } = buildSandboxArgs({
      workspaceRoot: ctx.workspaceRoot,
      cmd,
      timeoutSeconds: t,
      bwrapAvailable: BWRAP_AVAILABLE,
    });

    const start = Date.now();
    const child = spawn(command, args, {
      cwd: ctx.workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", PWD: "/workspace" },
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length >= STDOUT_CAP) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_CAP) {
        stdout = stdout.slice(0, STDOUT_CAP);
        truncated = true;
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length >= STDERR_CAP) return;
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(0, STDERR_CAP);
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), t * 1000);

    const result: BashResult = await new Promise((resolve) => {
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal: signal,
          durationMs: Date.now() - start,
          sandbox: BWRAP_AVAILABLE ? "bwrap" : "none",
          truncated,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + (err.message + "\n"),
          exitCode: null,
          signal: null,
          durationMs: Date.now() - start,
          sandbox: BWRAP_AVAILABLE ? "bwrap" : "none",
          truncated,
        });
      });
    });

    return { kind: "json", json: result as unknown as Record<string, unknown> };
  },
});

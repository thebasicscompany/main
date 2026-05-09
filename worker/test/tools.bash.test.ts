// BUILD-LOOP B.3 — bash tool. Two layers of test:
//   1. Unit: assert buildSandboxArgs produces the right bwrap argv (host-portable)
//   2. Functional: skipped on Windows; exercises the live spawn path when
//      `BWRAP_AVAILABLE=1` is in the env (set in worker Dockerfile).

import { describe, expect, it } from "vitest";
import { buildSandboxArgs } from "../src/tools/bash.js";
import { buildWorkerToolRegistry } from "../src/tools/index.js";

describe("bash — buildSandboxArgs", () => {
  it("emits bwrap argv with workspace bound rw and / read-only when bwrap is available", () => {
    const { command, args } = buildSandboxArgs({
      workspaceRoot: "/workspace",
      cmd: "echo hello",
      timeoutSeconds: 30,
      bwrapAvailable: true,
    });
    expect(command).toBe("bwrap");
    expect(args).toContain("--unshare-user");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("--die-with-parent");
    // /workspace bound rw
    const bindIdx = args.indexOf("--bind");
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(args[bindIdx + 1]).toBe("/workspace");
    expect(args[bindIdx + 2]).toBe("/workspace");
    // /etc replaced with tmpfs (so `cat /etc/passwd` finds nothing)
    const etcTmpfsIdx = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === "/etc");
    expect(etcTmpfsIdx).toBeGreaterThanOrEqual(0);
    // Final command is the user's `sh -c <cmd>`
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hello"]);
  });

  it("falls back to /bin/sh -c <cmd> when bwrap is unavailable", () => {
    const { command, args } = buildSandboxArgs({
      workspaceRoot: "/workspace",
      cmd: "echo hello",
      timeoutSeconds: 30,
      bwrapAvailable: false,
    });
    expect(command).toBe("/bin/sh");
    expect(args).toEqual(["-c", "echo hello"]);
  });
});

describe("bash — registration", () => {
  it("is approval-gated and mutating", () => {
    const reg = buildWorkerToolRegistry();
    const tool = reg.get("bash");
    expect(tool).toBeDefined();
    expect(tool?.mutating).toBe(true);
    expect(tool?.requiresApproval).toBe(true);
    expect(tool?.cost).toBe("medium");
  });
});

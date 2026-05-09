// BUILD-LOOP B.4 — approval middleware unit tests.
//
// Coverage scope: the gate primitives (AutoApprove / AutoReject) + a
// registry-level assertion that every mutating or explicitly-gated tool
// will trip the runner's approval flow. The full runner-integration test
// (real worker insert into pending_approvals, api resolves, tool runs)
// is owed in the Phase B exit-criteria smoke; today's coverage is
// sufficient to lock the contract.

import { describe, expect, it } from "vitest";
import {
  AutoApproveGate,
  AutoRejectGate,
} from "../src/approval-gate.js";
import { buildWorkerToolRegistry, type WorkerToolContext } from "../src/tools/index.js";

describe("ApprovalGate primitives", () => {
  it("AutoApproveGate returns approve / by=auto", async () => {
    const r = await new AutoApproveGate().await({
      runId: "r1",
      workspaceId: "w1",
      toolCallId: "t1",
      tool: "click_at_xy",
      params: { x: 1, y: 2 },
    });
    expect(r.decision).toBe("approve");
    expect(r.decidedBy).toBe("auto");
    expect(typeof r.approvalId).toBe("string");
  });

  it("AutoRejectGate returns reject / by=auto", async () => {
    const r = await new AutoRejectGate().await({
      runId: "r1",
      workspaceId: "w1",
      toolCallId: "t1",
      tool: "click_at_xy",
      params: { x: 1, y: 2 },
    });
    expect(r.decision).toBe("reject");
    expect(r.decidedBy).toBe("auto");
  });
});

describe("approval flag coverage on the tool registry", () => {
  // The runner gates whenever def.requiresApproval ?? def.mutating is true.
  // This test enumerates the tools we KNOW must be gated and asserts the
  // gate would fire. If a tool's flags drift, the test fails.
  const MUST_BE_GATED = [
    "click_at_xy",
    "type_text",
    "fill_input",
    "press_key",
    "upload_file",
    "dispatch_key",
    "delete_file",
    "write_file",
    "edit_file",
    "bash",
    "cdp_raw",
  ];

  // These are non-mutating (read/inspect) and should NOT trip the gate.
  const MUST_NOT_BE_GATED = [
    "screenshot",
    "goto_url",
    "js",
    "new_tab",
    "scroll",
    "wait_for_load",
    "wait_for_element",
    "wait_for_network_idle",
    "http_get",
    "ensure_real_tab",
    "extract",
    "read_file",
    "glob",
    "grep",
  ];

  const reg = buildWorkerToolRegistry();

  for (const name of MUST_BE_GATED) {
    it(`${name} is approval-gated`, () => {
      const t = reg.get(name);
      expect(t, `expected ${name} in registry`).toBeDefined();
      const gated = (t!.requiresApproval ?? t!.mutating) === true;
      expect(gated, `${name} must be gated (mutating=${t!.mutating}, requiresApproval=${String(t!.requiresApproval)})`).toBe(true);
    });
  }

  for (const name of MUST_NOT_BE_GATED) {
    it(`${name} is NOT approval-gated`, () => {
      const t = reg.get(name);
      expect(t, `expected ${name} in registry`).toBeDefined();
      const gated = (t!.requiresApproval ?? t!.mutating) === true;
      expect(gated, `${name} should not be gated (mutating=${t!.mutating}, requiresApproval=${String(t!.requiresApproval)})`).toBe(false);
    });
  }

  it("registry size is 32 (… + send_to_agent E.3)", () => {
    expect(reg.size).toBe(32);
  });

  it("ctx fields used by approval flow exist on WorkerToolContext", () => {
    // Compile-time check (TS): if this object accepts these names with
    // the right shapes, the runner's gate has all the data it needs.
    const _stub: Pick<WorkerToolContext, "runId" | "workspaceId" | "accountId"> = {
      runId: "r",
      workspaceId: "w",
      accountId: "a",
    };
    expect(_stub.runId).toBe("r");
  });
});

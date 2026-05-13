// BUILD-LOOP B.5 — plan tools.
// Each tool emits a canonical §11.1 event via ctx.publish. Test asserts
// the event shape; full SSE round-trip is exercised by the Phase B
// exit-criteria smoke (deferred — would otherwise require a fresh
// docker push + ECS run).

import { describe, expect, it } from "vitest";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";
import {
  buildWorkerToolRegistry,
  type PublishEvent,
  type WorkerToolContext,
} from "../src/tools/index.js";
import type { CdpSession } from "@basics/harness";

function makeCtx(captured: PublishEvent[]): WorkerToolContext {
  return {
    session: undefined as unknown as CdpSession,
    runId: "00000000-0000-0000-0000-000000000b05",
    workspaceId: "00000000-0000-0000-0000-000000000b05",
    accountId: "00000000-0000-0000-0000-000000000b05",
    workspaceRoot: "/tmp/test-workspace",
    publish: (e) => {
      captured.push(e);
    },
  };
}

describe("update_plan", () => {
  it("emits plan_updated with the steps payload", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    await tools.find((t) => t.name === "update_plan")!.execute({
      steps: [
        { id: "s1", title: "open the page" },
        { id: "s2", title: "click the button" },
        { id: "s3", title: "verify the result" },
      ],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("plan_updated");
    expect(captured[0]?.payload.steps).toHaveLength(3);
  });

  it("rejects empty step list", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    await expect(
      tools.find((t) => t.name === "update_plan")!.execute({ steps: [] }),
    ).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });

  it("rejects steps without id or title", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    await expect(
      tools.find((t) => t.name === "update_plan")!.execute({
        steps: [{ id: "", title: "x" }],
      }),
    ).rejects.toThrow();
  });
});

describe("set_step_status", () => {
  it("emits step_status with the right shape, optional note included", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    await tools.find((t) => t.name === "set_step_status")!.execute({
      stepId: "s1",
      status: "in_progress",
    });
    await tools.find((t) => t.name === "set_step_status")!.execute({
      stepId: "s1",
      status: "completed",
      note: "page loaded",
    });
    expect(captured).toEqual([
      { type: "step_status", payload: { stepId: "s1", status: "in_progress" } },
      { type: "step_status", payload: { stepId: "s1", status: "completed", note: "page loaded" } },
    ]);
  });

  it("rejects an unknown status enum", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    await expect(
      tools.find((t) => t.name === "set_step_status")!.execute({
        stepId: "s1",
        status: "garbage",
      }),
    ).rejects.toThrow();
  });
});

describe("report_finding", () => {
  it("emits finding with kind/title/body", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    await tools.find((t) => t.name === "report_finding")!.execute({
      kind: "evidence",
      title: "page heading",
      body: "the h1 text is 'Example Domain'",
    });
    expect(captured).toEqual([
      {
        type: "finding",
        payload: { kind: "evidence", title: "page heading", body: "the h1 text is 'Example Domain'" },
      },
    ]);
  });
});

describe("final_answer", () => {
  it("emits final_answer with the text payload", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    const r = (await tools.find((t) => t.name === "final_answer")!.execute({
      text: "page rendered as expected",
    })) as { kind: "text"; text: string };
    expect(r.text).toBe("ok");
    expect(captured).toEqual([
      { type: "final_answer", payload: { text: "page rendered as expected" } },
    ]);
  });
});

describe("plan-tool registration", () => {
  it("all four tools are non-mutating + non-gated", () => {
    const reg = buildWorkerToolRegistry();
    for (const name of ["update_plan", "set_step_status", "report_finding", "final_answer"]) {
      const t = reg.get(name);
      expect(t, name).toBeDefined();
      expect(t!.mutating).toBe(false);
      expect((t!.requiresApproval ?? t!.mutating)).toBe(false);
    }
  });

  it("registry size is 39 (… + attach_artifact + send_email + send_sms) + propose_automation + activate_automation", () => {
    expect(buildWorkerToolRegistry().size).toBe(39);
  });
});

describe("end-to-end plan sequence (in-memory capture)", () => {
  it("update_plan + 3× set_step_status produces the §11.1 event order", async () => {
    const captured: PublishEvent[] = [];
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => makeCtx(captured),
    });
    const updatePlan = tools.find((t) => t.name === "update_plan")!;
    const setStatus = tools.find((t) => t.name === "set_step_status")!;

    await updatePlan.execute({
      steps: [
        { id: "s1", title: "step one" },
        { id: "s2", title: "step two" },
        { id: "s3", title: "step three" },
      ],
    });
    await setStatus.execute({ stepId: "s1", status: "completed" });
    await setStatus.execute({ stepId: "s2", status: "completed" });
    await setStatus.execute({ stepId: "s3", status: "completed" });

    expect(captured.map((e) => e.type)).toEqual([
      "plan_updated",
      "step_status",
      "step_status",
      "step_status",
    ]);
    expect(captured[0]?.payload.steps).toHaveLength(3);
    for (let i = 1; i <= 3; i++) {
      expect(captured[i]?.payload.stepId).toBe(`s${i}`);
      expect(captured[i]?.payload.status).toBe("completed");
    }
  });
});

// BUILD-LOOP E.2 — spawn_subagent tests.

import { describe, expect, it } from "vitest";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";
import {
  buildWorkerToolRegistry,
  type WorkerToolContext,
} from "../src/tools/index.js";
import { StubSubagentRunner, intersectTools } from "../src/subagent.js";
import type { CdpSession } from "@basics/harness";

const baseCtx = (overrides: Partial<WorkerToolContext> = {}): WorkerToolContext => {
  const reg = buildWorkerToolRegistry();
  return {
    session: undefined as unknown as CdpSession,
    runId: "00000000-0000-0000-0000-000000000e02",
    workspaceId: "00000000-0000-0000-0000-000000000e02",
    accountId: "00000000-0000-0000-0000-000000000e02",
    workspaceRoot: "/tmp",
    publish: () => undefined,
    subagentRunner: new StubSubagentRunner(),
    toolRegistryNames: [...reg.keys()],
    ...overrides,
  };
};

describe("intersectTools", () => {
  it("returns tools present in both registry and allowed", () => {
    expect(intersectTools(["a", "b", "c"], ["b", "c", "z"])).toEqual(["b", "c"]);
  });

  it("preserves registry order, drops unknown allowed entries", () => {
    expect(intersectTools(["screenshot", "goto_url", "js"], ["js", "screenshot", "no_such"])).toEqual(
      ["screenshot", "js"],
    );
  });
});

describe("spawn_subagent — happy path", () => {
  it("spawns, publishes started/finished, returns transcript + final answer", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = baseCtx({
      publish: (e) => { captured.push(e); },
    });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "spawn_subagent")!.execute({
      goal: "verify the cart total",
      allowedTools: ["screenshot", "js", "extract"],
    })) as {
      kind: "json";
      json: { finalAnswer: string; stopReason: string; turnsUsed: number; transcript: unknown[] };
    };
    expect(r.json.stopReason).toBe("final_answer");
    expect(r.json.finalAnswer).toMatch(/verify the cart total/);
    expect(r.json.transcript.length).toBeGreaterThan(0);

    expect(captured.map((e) => e.type)).toEqual(["subagent_started", "subagent_finished"]);
    expect(captured[0]?.payload.allowedTools).toEqual(["screenshot", "js", "extract"]);
    expect(captured[0]?.payload.writable).toBe(false);
    expect(captured[1]?.payload.stopReason).toBe("final_answer");
  });

  it("default maxTurns is 16; default writable is false", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = baseCtx({ publish: (e) => { captured.push(e); } });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "spawn_subagent")!.execute({
      goal: "x",
      allowedTools: ["js"],
    });
    expect(captured[0]?.payload.maxTurns).toBe(16);
    expect(captured[0]?.payload.writable).toBe(false);
  });

  it("filters allowedTools to those in the registry; unknown names are silently dropped", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = baseCtx({ publish: (e) => { captured.push(e); } });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "spawn_subagent")!.execute({
      goal: "x",
      allowedTools: ["js", "nonexistent_tool_zzz", "screenshot"],
    });
    expect(captured[0]?.payload.allowedTools).toEqual(["screenshot", "js"]);
  });
});

describe("spawn_subagent — guardrails", () => {
  it("throws subagent_no_tools when zero allowed match the registry", async () => {
    const ctx = baseCtx();
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "spawn_subagent")!.execute({
        goal: "x",
        allowedTools: ["nonexistent1", "nonexistent2"],
      }),
    ).rejects.toThrow(/subagent_no_tools/);
  });

  it("throws subagent_unavailable when ctx.subagentRunner is missing", async () => {
    const ctx = baseCtx({ subagentRunner: undefined });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "spawn_subagent")!.execute({
        goal: "x",
        allowedTools: ["js"],
      }),
    ).rejects.toThrow(/subagent_unavailable/);
  });

  it("throws subagent_unavailable when ctx.toolRegistryNames is missing", async () => {
    const ctx = baseCtx({ toolRegistryNames: [] });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "spawn_subagent")!.execute({
        goal: "x",
        allowedTools: ["js"],
      }),
    ).rejects.toThrow(/subagent_unavailable/);
  });

  it("zod rejects empty allowedTools array", async () => {
    const ctx = baseCtx();
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "spawn_subagent")!.execute({
        goal: "x",
        allowedTools: [],
      }),
    ).rejects.toThrow();
  });

  it("zod rejects maxTurns > 64", async () => {
    const ctx = baseCtx();
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "spawn_subagent")!.execute({
        goal: "x",
        allowedTools: ["js"],
        maxTurns: 100,
      }),
    ).rejects.toThrow();
  });
});

describe("spawn_subagent — registration", () => {
  it("is approval-gated, mutating, cost=high", () => {
    const reg = buildWorkerToolRegistry();
    const tool = reg.get("spawn_subagent");
    expect(tool?.mutating).toBe(true);
    expect(tool?.requiresApproval).toBe(true);
    expect(tool?.cost).toBe("high");
  });

  it("registry size is 32 (… + send_to_agent)", () => {
    expect(buildWorkerToolRegistry().size).toBe(32);
  });
});

describe("E.2 verify — verifier subagent with read-only tools, transcript appears", () => {
  it("parent invokes spawn_subagent({allowedTools: ['screenshot','js','extract']}); transcript contains text", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = baseCtx({ publish: (e) => { captured.push(e); } });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "spawn_subagent")!.execute({
      goal: "verify the order total matches the receipt PDF",
      allowedTools: ["screenshot", "js", "extract", "http_get"],
      maxTurns: 8,
    })) as {
      kind: "json";
      json: { transcript: Array<{ role: string; text: string }>; finalAnswer: string };
    };
    // Subagent's transcript appears in the result (parent-visible nested timeline).
    expect(r.json.transcript.length).toBeGreaterThan(0);
    expect(r.json.finalAnswer).toContain("verify the order total");
    // Parent run's agent_activity gets two events (started + finished) so
    // the timeline shows the nested span.
    expect(captured.find((e) => e.type === "subagent_started")?.payload.maxTurns).toBe(8);
    expect(captured.find((e) => e.type === "subagent_finished")?.payload.stopReason).toBe(
      "final_answer",
    );
  });
});

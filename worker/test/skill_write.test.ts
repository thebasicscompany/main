// BUILD-LOOP D.2 (reconciled per A.5) — skill_write tool tests.
//
// Verify equivalent: spec said "write a file via write_file; within 5s the
// agent_skills row exists" — with skills now in the DB, the equivalent
// is "call skill_write; the row exists immediately in the SkillStore".

import { describe, expect, it } from "vitest";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";
import { buildWorkerToolRegistry, type WorkerToolContext } from "../src/tools/index.js";
import { InMemorySkillStore } from "../src/skill-store.js";
import type { CdpSession } from "@basics/harness";

const baseCtx = (overrides: Partial<WorkerToolContext> = {}): WorkerToolContext => ({
  session: undefined as unknown as CdpSession,
  runId: "00000000-0000-0000-0000-000000000d02",
  workspaceId: "00000000-0000-0000-0000-000000000d02",
  accountId: "00000000-0000-0000-0000-000000000d02",
  workspaceRoot: "/tmp",
  publish: () => undefined,
  skillStore: new InMemorySkillStore(),
  ...overrides,
});

const STAMP = "Last-verified: 2026-05-09\n\n";

describe("skill_write — happy path", () => {
  it("inserts a skill row and emits skill_written event", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const store = new InMemorySkillStore();
    const ctx = baseCtx({
      publish: (e) => { captured.push(e); },
      skillStore: store,
    });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "skill_write")!.execute({
      name: "selectors",
      description: "stable selectors for example.com",
      body: STAMP + "h1: page heading\nlink: a[href]",
      host: "example.com",
      // syntheticPath defaults to skills/<host>/<name>.md → selectors path
      // but selectors.md REQUIRES the stamp; our path is selectors not selectors.md
      // → stamp not required. Pass an explicit syntheticPath to test stamp-required path.
      syntheticPath: "skills/example.com/INDEX.md",
    })) as { kind: "json"; json: { skillId: string; pendingReview: boolean } };
    expect(r.json.skillId).toBeDefined();
    expect(r.json.pendingReview).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.host).toBe("example.com");
    expect(captured).toEqual([
      expect.objectContaining({
        type: "skill_written",
        payload: expect.objectContaining({
          name: "selectors",
          host: "example.com",
          pendingReview: true,
        }),
      }),
    ]);
  });

  it("respects scope + confidence overrides", async () => {
    const store = new InMemorySkillStore();
    const ctx = baseCtx({ skillStore: store });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "skill_write")!.execute({
      name: "shared-tip",
      description: "x",
      body: "ok",
      scope: "workspace",
      confidence: 0.9,
      syntheticPath: "skills/example.com/notes.md",
    });
    expect(store.rows[0]?.scope).toBe("workspace");
  });
});

describe("skill_write — content policy reject (D.1 validator reused)", () => {
  it("rejects sk-ant-… in body, publishes skill_write_blocked, no row inserted", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const store = new InMemorySkillStore();
    const ctx = baseCtx({
      publish: (e) => { captured.push(e); },
      skillStore: store,
    });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "skill_write")!.execute({
        name: "tainted",
        description: "x",
        body: "saw sk-ant-api03-RkodwpEntz3krpXiYLmjwQw6kmH00ORu9ha4PEpBqWJDnTiA5XawIw earlier",
        syntheticPath: "skills/example.com/notes.md",
      }),
    ).rejects.toThrow(/skill_write_blocked: secret_detected/);
    expect(store.rows).toHaveLength(0);
    expect(captured.map((e) => e.type)).toEqual(["skill_write_blocked"]);
  });

  it("rejects pixel coords", async () => {
    const ctx = baseCtx();
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "skill_write")!.execute({
        name: "checkout",
        description: "the flow",
        body: "click 432, 198 to submit",
        syntheticPath: "skills/example.com/flows/checkout.md",
      }),
    ).rejects.toThrow(/pixel_coord_detected/);
  });

  it("requires Last-verified stamp on selectors path", async () => {
    const ctx = baseCtx();
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "skill_write")!.execute({
        name: "selectors",
        description: "x",
        body: "h1: page heading",
        syntheticPath: "skills/example.com/selectors.md",
      }),
    ).rejects.toThrow(/missing_verification_stamp/);
  });
});

describe("skill_write — registration + flags", () => {
  it("is mutating: true but requiresApproval: false (pending_review IS the gate)", () => {
    const reg = buildWorkerToolRegistry();
    const tool = reg.get("skill_write");
    expect(tool?.mutating).toBe(true);
    expect(tool?.requiresApproval).toBe(false);
  });

  it("registry size is 32 (… + send_to_agent)", () => {
    expect(buildWorkerToolRegistry().size).toBe(32);
  });
});

describe("skill_write — no skillStore", () => {
  it("throws skill_write_unavailable when ctx.skillStore is undefined", async () => {
    const ctx = baseCtx({ skillStore: undefined });
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "skill_write")!.execute({
        name: "x",
        description: "x",
        body: "ok",
        syntheticPath: "skills/example.com/notes.md",
      }),
    ).rejects.toThrow(/skill_write_unavailable/);
  });
});

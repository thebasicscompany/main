import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  registerTools,
  toolRequiresApproval,
} from "./define.js";

interface FakeCtx {
  runId: string;
}

describe("defineTool", () => {
  it("accepts a valid definition unchanged", () => {
    const t = defineTool({
      name: "screenshot",
      description: "Capture the current page.",
      params: z.object({ full: z.boolean().optional() }),
      mutating: false,
      cost: "medium",
      execute: async (_args, _ctx: FakeCtx) => ({
        kind: "image",
        b64: "AA==",
      }),
    });
    expect(t.name).toBe("screenshot");
    expect(t.mutating).toBe(false);
    expect(t.cost).toBe("medium");
  });

  it("rejects an invalid name", () => {
    expect(() =>
      defineTool({
        name: "Screenshot", // capital — disallowed
        description: "x",
        params: z.object({}),
        mutating: false,
        cost: "low",
        execute: async () => ({ kind: "text", text: "x" }),
      }),
    ).toThrow(/must match/);
  });

  it("approval defaults to mutating flag, override wins", () => {
    expect(toolRequiresApproval({ mutating: true })).toBe(true);
    expect(toolRequiresApproval({ mutating: false })).toBe(false);
    expect(toolRequiresApproval({ mutating: false, requiresApproval: true })).toBe(true);
    expect(toolRequiresApproval({ mutating: true, requiresApproval: false })).toBe(false);
  });
});

describe("registerTools", () => {
  it("collects tools by name", () => {
    const screenshot = defineTool({
      name: "screenshot",
      description: "x",
      params: z.object({}),
      mutating: false,
      cost: "medium",
      execute: async (_a, _c: FakeCtx) => ({ kind: "image", b64: "AA==" }),
    });
    const goto_url = defineTool({
      name: "goto_url",
      description: "y",
      params: z.object({ url: z.string().url() }),
      mutating: true,
      cost: "low",
      execute: async (_a, _c: FakeCtx) => ({ kind: "text", text: "ok" }),
    });
    const reg = registerTools<FakeCtx>(screenshot, goto_url);
    expect(reg.size).toBe(2);
    expect(reg.get("screenshot")).toBe(screenshot);
    expect(reg.get("goto_url")).toBe(goto_url);
  });

  it("rejects duplicates", () => {
    const a = defineTool({
      name: "x",
      description: "",
      params: z.object({}),
      mutating: false,
      cost: "low",
      execute: async (_a, _c: FakeCtx) => ({ kind: "text", text: "" }),
    });
    expect(() => registerTools<FakeCtx>(a, a)).toThrow(/duplicate/);
  });
});

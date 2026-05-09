import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, registerTools } from "@basics/shared";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";

interface FakeCtx {
  runId: string;
  publish: (event: unknown) => void;
  workspaceRoot?: string;
}

describe("toOpencodeTools", () => {
  const screenshot = defineTool({
    name: "screenshot",
    description: "Capture page.",
    params: z.object({ full: z.boolean().optional() }),
    mutating: false,
    cost: "medium",
    execute: async (args, ctx: FakeCtx) => {
      ctx.publish({ type: "screenshot", runId: ctx.runId, full: args.full });
      return { kind: "image", b64: "AA==" };
    },
  });

  const click = defineTool({
    name: "click_at_xy",
    description: "Click coords.",
    params: z.object({ x: z.number().int(), y: z.number().int() }),
    mutating: true,
    cost: "low",
    execute: async (_a, _c: FakeCtx) => ({ kind: "text", text: "clicked" }),
  });

  const reg = registerTools<FakeCtx>(screenshot, click);

  it("emits one entry per tool with the expected JSON shape", () => {
    let resolved = 0;
    const out = toOpencodeTools(reg, {
      resolveContext: () => {
        resolved++;
        return { runId: "r1", publish: () => {} };
      },
    });

    expect(out).toHaveLength(2);

    const ss = out.find((t) => t.name === "screenshot");
    expect(ss).toBeDefined();
    expect(ss?.description).toBe("Capture page.");
    expect(ss?.meta).toEqual({ mutating: false, requiresApproval: false, cost: "medium" });
    // zod 4 toJSONSchema on z.object produces a Draft-2020-12 object.
    expect(ss?.parameters).toMatchObject({ type: "object" });

    const c = out.find((t) => t.name === "click_at_xy");
    expect(c?.meta).toEqual({ mutating: true, requiresApproval: true, cost: "low" });

    // Context resolved exactly once when execute runs.
    expect(resolved).toBe(0);
  });

  it("validates input via zod and runs execute when valid", async () => {
    const events: unknown[] = [];
    const out = toOpencodeTools(reg, {
      resolveContext: () => ({ runId: "r1", publish: (e) => events.push(e) }),
    });
    const ss = out.find((t) => t.name === "screenshot")!;

    const r = await ss.execute({ full: true });
    expect(r).toEqual({ kind: "image", b64: "AA==" });
    expect(events).toEqual([{ type: "screenshot", runId: "r1", full: true }]);
  });

  it("rejects malformed input via zod", async () => {
    const out = toOpencodeTools(reg, {
      resolveContext: () => ({ runId: "r1", publish: () => {} }),
    });
    const c = out.find((t) => t.name === "click_at_xy")!;

    // y is missing — should throw zod error.
    await expect(c.execute({ x: 5 })).rejects.toThrow();
    // x is wrong type
    await expect(c.execute({ x: "five", y: 5 })).rejects.toThrow();
  });
});

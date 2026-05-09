// BUILD-LOOP D.5 — screenshot ratio metric tests.

import { describe, expect, it } from "vitest";
import { computeRunRatio, ratioDropPct } from "../src/screenshot-ratio.js";

const RUN = "00000000-0000-0000-0000-000000000d05";
const OTHER_RUN = "ffffffff-ffff-ffff-ffff-ffffffffffff";

interface Row {
  agent_run_id: string;
  activity_type: string;
  payload?: { tool?: string };
}

const tcStart = (run: string, tool: string): Row => ({
  agent_run_id: run,
  activity_type: "tool_call_start",
  payload: { tool },
});

describe("computeRunRatio — basic counting", () => {
  it("zero events → 0 ratio", () => {
    const r = computeRunRatio(RUN, []);
    expect(r).toEqual({ runId: RUN, totalToolCalls: 0, screenshotCalls: 0, ratio: 0 });
  });

  it("3 tool calls, 1 screenshot → ratio 1/3", () => {
    const r = computeRunRatio(RUN, [
      tcStart(RUN, "goto_url"),
      tcStart(RUN, "screenshot"),
      tcStart(RUN, "js"),
    ]);
    expect(r.totalToolCalls).toBe(3);
    expect(r.screenshotCalls).toBe(1);
    expect(r.ratio).toBeCloseTo(1 / 3);
  });

  it("ignores rows with the wrong run id", () => {
    const r = computeRunRatio(RUN, [
      tcStart(RUN, "goto_url"),
      tcStart(OTHER_RUN, "screenshot"),
      tcStart(OTHER_RUN, "screenshot"),
    ]);
    expect(r.totalToolCalls).toBe(1);
    expect(r.screenshotCalls).toBe(0);
  });

  it("standalone 'screenshot' events do not count as a tool call (avoids double-count)", () => {
    const r = computeRunRatio(RUN, [
      tcStart(RUN, "screenshot"),
      // The runner also emits a separate 'screenshot' event with s3Key payload
      // alongside the tool_call_start; that one is data, not a tool call.
      { agent_run_id: RUN, activity_type: "screenshot", payload: {} },
      tcStart(RUN, "goto_url"),
    ]);
    expect(r.totalToolCalls).toBe(2);
    expect(r.screenshotCalls).toBe(1);
  });

  it("ignores non-tool events (run_started, plan_updated, etc.)", () => {
    const r = computeRunRatio(RUN, [
      { agent_run_id: RUN, activity_type: "run_started", payload: {} },
      { agent_run_id: RUN, activity_type: "plan_updated", payload: {} },
      tcStart(RUN, "goto_url"),
    ]);
    expect(r.totalToolCalls).toBe(1);
  });
});

describe("ratioDropPct — D.5 headline assertion", () => {
  it("returns 0 when first run had no screenshots", () => {
    const a = { runId: "1", totalToolCalls: 5, screenshotCalls: 0, ratio: 0 };
    const b = { runId: "2", totalToolCalls: 5, screenshotCalls: 1, ratio: 0.2 };
    expect(ratioDropPct(a, b)).toBe(0);
  });

  it("first run 0.5 → 10th run 0.2 = 60% drop (>= 40% target)", () => {
    const first = { runId: "1", totalToolCalls: 10, screenshotCalls: 5, ratio: 0.5 };
    const tenth = { runId: "10", totalToolCalls: 10, screenshotCalls: 2, ratio: 0.2 };
    const drop = ratioDropPct(first, tenth);
    expect(drop).toBeCloseTo(0.6);
    expect(drop).toBeGreaterThanOrEqual(0.4);
  });

  it("drop below 40% fails the target", () => {
    const first = { runId: "1", totalToolCalls: 10, screenshotCalls: 5, ratio: 0.5 };
    const tenth = { runId: "10", totalToolCalls: 10, screenshotCalls: 4, ratio: 0.4 };
    const drop = ratioDropPct(first, tenth);
    expect(drop).toBeCloseTo(0.2);
    expect(drop).toBeLessThan(0.4);
  });

  it("D.5 spec — synthetic 1st vs 10th run with skills accumulating", () => {
    // Simulated 1st run: every-tool-after-goto is a screenshot (no skills yet).
    const firstRunRows = [
      tcStart("r1", "goto_url"),
      tcStart("r1", "screenshot"),
      tcStart("r1", "screenshot"),
      tcStart("r1", "click_at_xy"),
      tcStart("r1", "screenshot"),
      tcStart("r1", "js"),
      tcStart("r1", "screenshot"),
    ];
    // 10th run: skills cached → fewer screenshots, more selectors via js/extract.
    const tenthRunRows = [
      tcStart("r10", "goto_url"),
      tcStart("r10", "extract"),
      tcStart("r10", "click_at_xy"),
      tcStart("r10", "extract"),
      tcStart("r10", "screenshot"), // one verification shot
      tcStart("r10", "js"),
      tcStart("r10", "js"),
    ];
    const r1 = computeRunRatio("r1", firstRunRows);
    const r10 = computeRunRatio("r10", tenthRunRows);
    const drop = ratioDropPct(r1, r10);
    expect(r1.ratio).toBeGreaterThan(r10.ratio);
    expect(drop).toBeGreaterThanOrEqual(0.4);
  });
});

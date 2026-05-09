// BUILD-LOOP C.3 — daily ceiling enforcement.
// Verify: a workspace with ceiling = $0.10 (= 10¢) crosses 0.8 → emits
// budget_warning ONCE; crosses 1.0 → exceeded=true; the runner side then
// surfaces run.status='budget_exceeded' (asserted at the runner-integration
// test deferred for the Phase B/C exit smoke).

import { describe, expect, it } from "vitest";
import {
  StatefulBudgetGate,
  InMemoryBudgetSource,
  BudgetExceededError,
} from "../src/budget-gate.js";

const ws = "ws-test";
const ac = "ac-test";

describe("BudgetGate — no ceiling configured", () => {
  it("returns nulls + no warn / exceeded when ceiling is unset", async () => {
    const src = new InMemoryBudgetSource();
    src.setUsed(ws, ac, 999_999);
    const gate = new StatefulBudgetGate(src);
    const r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.ceilingCents).toBeNull();
    expect(r.usedPct).toBeNull();
    expect(r.shouldWarn).toBe(false);
    expect(r.exceeded).toBe(false);
  });
});

describe("BudgetGate — warning threshold (>0.8)", () => {
  it("first turn under 0.8 → no warn", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 1_000); // $10
    src.setUsed(ws, ac, 500);  // 50%
    const gate = new StatefulBudgetGate(src);
    const r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.usedPct).toBeCloseTo(0.5);
    expect(r.shouldWarn).toBe(false);
    expect(r.exceeded).toBe(false);
  });

  it("crossing 0.8 emits exactly ONE warn (the first time)", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 100);
    const gate = new StatefulBudgetGate(src);

    // Turn 1: 30¢ used → 30%. No warn.
    src.setUsed(ws, ac, 30);
    let r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.shouldWarn).toBe(false);

    // Turn 2: 85¢ used → 85%. First crossing, warn fires.
    src.setUsed(ws, ac, 85);
    r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.shouldWarn).toBe(true);
    expect(r.usedPct).toBeCloseTo(0.85);

    // Turn 3: 90¢ used → 90%. Already warned; no second warn.
    src.setUsed(ws, ac, 90);
    r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.shouldWarn).toBe(false);
  });

  it("usedPct exactly 0.8 does NOT warn (>0.8 strict)", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 100);
    src.setUsed(ws, ac, 80);
    const gate = new StatefulBudgetGate(src);
    const r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.shouldWarn).toBe(false);
  });

  it("warning state is per (workspace, account)", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 100);
    src.setUsed(ws, "ac1", 90);
    src.setUsed(ws, "ac2", 90);
    const gate = new StatefulBudgetGate(src);

    expect((await gate.check({ workspaceId: ws, accountId: "ac1" })).shouldWarn).toBe(true);
    // ac2 hasn't warned yet — its first time crossing.
    expect((await gate.check({ workspaceId: ws, accountId: "ac2" })).shouldWarn).toBe(true);
    // Second check on ac1 — already warned.
    expect((await gate.check({ workspaceId: ws, accountId: "ac1" })).shouldWarn).toBe(false);
  });
});

describe("BudgetGate — exceeded (≥1.0)", () => {
  it("ceiling=10¢ + used=10¢ → exceeded=true (and shouldWarn=false)", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 10);
    src.setUsed(ws, ac, 10);
    const gate = new StatefulBudgetGate(src);
    const r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.exceeded).toBe(true);
    expect(r.usedPct).toBe(1);
    // Don't warn AT exactly the moment of exceeded — caller emits run_completed
    // with status='budget_exceeded' instead.
    expect(r.shouldWarn).toBe(false);
  });

  it("ceiling=10¢ + used=15¢ → usedPct=1.5, exceeded=true", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 10);
    src.setUsed(ws, ac, 15);
    const gate = new StatefulBudgetGate(src);
    const r = await gate.check({ workspaceId: ws, accountId: ac });
    expect(r.usedPct).toBe(1.5);
    expect(r.exceeded).toBe(true);
  });
});

describe("BudgetGate — sequenced 'run that would exceed' (BUILD-LOOP C.3 spec)", () => {
  // Set ceiling to $0.10 (10¢). Trigger 4 turns of 3¢ each (12¢ total).
  // Expected sequence:
  //   turn 1: 3¢ used (30%)  → no warn, no exceed
  //   turn 2: 6¢ used (60%)  → no warn
  //   turn 3: 9¢ used (90%)  → SHOULD WARN (first crossing of 0.8)
  //   turn 4: 12¢ used (120%) → EXCEEDED (runner emits budget_exceeded)
  it("matches the spec's '$0.10 ceiling' scenario", async () => {
    const src = new InMemoryBudgetSource();
    src.setCeiling(ws, 10);
    const gate = new StatefulBudgetGate(src);

    src.setUsed(ws, ac, 3);
    expect((await gate.check({ workspaceId: ws, accountId: ac }))).toMatchObject({
      shouldWarn: false,
      exceeded: false,
    });

    src.setUsed(ws, ac, 6);
    expect((await gate.check({ workspaceId: ws, accountId: ac }))).toMatchObject({
      shouldWarn: false,
      exceeded: false,
    });

    src.setUsed(ws, ac, 9);
    expect((await gate.check({ workspaceId: ws, accountId: ac }))).toMatchObject({
      shouldWarn: true,
      exceeded: false,
    });

    src.setUsed(ws, ac, 12);
    expect((await gate.check({ workspaceId: ws, accountId: ac }))).toMatchObject({
      shouldWarn: false,
      exceeded: true,
    });
  });
});

describe("BudgetExceededError shape", () => {
  it("carries used + ceiling for the run_completed payload", () => {
    const err = new BudgetExceededError(120, 100);
    expect(err.usedCents).toBe(120);
    expect(err.ceilingCents).toBe(100);
    expect(err.message).toMatch(/budget_exceeded.*120.*100/);
    expect(err.name).toBe("BudgetExceededError");
  });
});

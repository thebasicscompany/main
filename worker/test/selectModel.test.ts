// CLOUD-AGENT-PLAN §6.2 routing matrix tests + the §6.2 budget overrides
// + workspace overrides + §6.3 failover.

import { describe, expect, it } from "vitest";
import {
  selectModel,
  BudgetExceededError,
  type SelectModelInput,
} from "../src/router/selectModel.js";

const base: SelectModelInput = { turnKind: "plan" };

describe("selectModel — §6.2 matrix", () => {
  it("plan → claude-sonnet-4-6, fallbacks gpt-5 then gemini-2.5-pro", () => {
    const r = selectModel({ ...base, turnKind: "plan" });
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.fallbacks.map((f) => f.model)).toEqual(["gpt-5", "gemini-2.5-pro"]);
  });

  it("act with no images → claude-sonnet-4-6, gpt-5 then gemini-2.5-pro", () => {
    const r = selectModel({ turnKind: "act", imageCount: 0 });
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.fallbacks.map((f) => f.model)).toEqual(["gpt-5", "gemini-2.5-pro"]);
  });

  it("act with images → fallbacks shrink to gemini-2.5-pro only", () => {
    const r = selectModel({ turnKind: "act", imageCount: 2 });
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.fallbacks.map((f) => f.model)).toEqual(["gemini-2.5-pro"]);
  });

  it("read → claude-haiku, fallback gemini-2.5-flash", () => {
    const r = selectModel({ turnKind: "read" });
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.fallbacks.map((f) => f.model)).toEqual(["gemini-2.5-flash"]);
  });

  it("classify → gemini-2.5-flash, fallback claude-haiku", () => {
    const r = selectModel({ turnKind: "classify" });
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.fallbacks.map((f) => f.model)).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("summarize → gemini-2.5-pro, fallback claude-sonnet-4-6", () => {
    const r = selectModel({ turnKind: "summarize" });
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.fallbacks.map((f) => f.model)).toEqual(["claude-sonnet-4-6"]);
  });

  it("recover → claude-sonnet-4-6, no fallbacks (recovery uses one provider for stability)", () => {
    const r = selectModel({ turnKind: "recover" });
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.fallbacks).toHaveLength(0);
  });

  it("populates pricing for the chosen model from pricing.json", () => {
    const r = selectModel({ turnKind: "plan" });
    expect(r.pricing.input).toBeGreaterThan(0);
    expect(r.pricing.output).toBeGreaterThan(0);
  });
});

describe("selectModel — §6.2 budget downshift", () => {
  it("usedPct > 0.8 downshifts sonnet → haiku and flags downshifted=true", () => {
    const r = selectModel({ turnKind: "plan", workspaceBudgetUsedPct: 0.85 });
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.downshifted).toBe(true);
    expect(r.reason).toMatch(/downshift_budget/);
  });

  it("usedPct > 0.8 downshifts gemini-2.5-pro → gemini-2.5-flash on summarize", () => {
    const r = selectModel({ turnKind: "summarize", workspaceBudgetUsedPct: 0.9 });
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.downshifted).toBe(true);
  });

  it("usedPct >= 1.0 throws BudgetExceededError", () => {
    expect(() =>
      selectModel({ turnKind: "plan", workspaceBudgetUsedPct: 1.0 }),
    ).toThrow(BudgetExceededError);
    expect(() =>
      selectModel({ turnKind: "plan", workspaceBudgetUsedPct: 1.5 }),
    ).toThrow(BudgetExceededError);
  });

  it("usedPct <= 0.8 does NOT downshift", () => {
    const r = selectModel({ turnKind: "plan", workspaceBudgetUsedPct: 0.5 });
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.downshifted).toBeUndefined();
  });
});

describe("selectModel — workspace overrides", () => {
  it("preferredProvider=google swaps sonnet → gemini-2.5-pro on plan", () => {
    const r = selectModel({
      turnKind: "plan",
      workspaceOverrides: { preferredProvider: "google" },
    });
    expect(r.provider).toBe("google");
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.reason).toMatch(/preferred=google/);
  });

  it("preferredProvider=openai swaps sonnet → gpt-5 on plan", () => {
    const r = selectModel({
      turnKind: "plan",
      workspaceOverrides: { preferredProvider: "openai" },
    });
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5");
  });

  it("forbiddenModels filters claude-sonnet-4-6 → falls to gpt-5", () => {
    const r = selectModel({
      turnKind: "plan",
      workspaceOverrides: { forbiddenModels: ["claude-sonnet-4-6"] },
    });
    expect(r.model).toBe("gpt-5");
    expect(r.reason).toMatch(/forbidden=claude-sonnet-4-6/);
  });

  it("forbidden + preferred together: forbidden wins, falls back without preferred swap", () => {
    const r = selectModel({
      turnKind: "plan",
      workspaceOverrides: {
        forbiddenModels: ["claude-sonnet-4-6", "gemini-2.5-pro"],
      },
    });
    // Both sonnet and gemini-pro forbidden; chain becomes [sonnet, gpt-5, gemini-pro]
    // → after filter [gpt-5]
    expect(r.model).toBe("gpt-5");
  });

  it("throws no_eligible_model when every chain entry is forbidden", () => {
    expect(() =>
      selectModel({
        turnKind: "plan",
        workspaceOverrides: {
          forbiddenModels: ["claude-sonnet-4-6", "gpt-5", "gemini-2.5-pro"],
        },
      }),
    ).toThrow(/no_eligible_model/);
  });
});

describe("selectModel — §6.3 failover", () => {
  it("simulated 429 on anthropic skips sonnet → goes to gpt-5", () => {
    const r = selectModel({
      turnKind: "plan",
      recentFailures: [{ provider: "anthropic", reason: "rate_limited" }],
    });
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5");
    expect(r.reason).toMatch(/recently_failed=anthropic/);
  });

  it("anthropic + openai both failed → only gemini-2.5-pro left on plan", () => {
    const r = selectModel({
      turnKind: "plan",
      recentFailures: [
        { provider: "anthropic", reason: "rate_limited" },
        { provider: "openai", reason: "rate_limited" },
      ],
    });
    expect(r.provider).toBe("google");
    expect(r.model).toBe("gemini-2.5-pro");
  });

  it("all 3 failed → keeps original order (caller must surface provider_unavailable)", () => {
    const r = selectModel({
      turnKind: "plan",
      recentFailures: [
        { provider: "anthropic", reason: "rate_limited" },
        { provider: "openai", reason: "rate_limited" },
        { provider: "google", reason: "rate_limited" },
      ],
    });
    expect(r.model).toBe("claude-sonnet-4-6");
  });
});

// CLOUD-AGENT-PLAN §13 reconciled C.2 — the worker bumps the existing
// usage_tracking row instead of writing a new run_cost_lines table.
//
// Verify spec (revised): run a known synthetic 10-turn workflow with
// mixed providers; sum cents in the in-memory aggregate; confirm the
// total matches the deterministic Σ(turn.tokens × pricing) calculation
// to <1% drift (in practice: 0, since priceTurn rounds once per turn
// and our reference does the same).

import { describe, expect, it } from "vitest";
import {
  InMemoryCostTracker,
  priceTurn,
  type TurnUsage,
} from "../src/cost-tracker.js";
import pricingDoc from "../pricing.json" with { type: "json" };

interface PricingDoc {
  models: Record<string, { provider: string; input: number; output: number }>;
}
const PRICING = pricingDoc as PricingDoc;

describe("priceTurn", () => {
  it("computes cents: claude-sonnet-4-6 with 10k input + 5k output", () => {
    const cost = priceTurn({ model: "claude-sonnet-4-6", inputTokens: 10_000, outputTokens: 5_000 });
    // sonnet: $3/M input, $15/M output → 0.03 + 0.075 = $0.105 → 11 cents (round)
    expect(cost.cents).toBe(Math.round(((3 * 10_000) / 1_000_000 + (15 * 5_000) / 1_000_000) * 100));
    expect(cost.cents).toBe(11);
  });

  it("computes cents: gemini-2.5-flash with 100k input + 1k output", () => {
    const cost = priceTurn({ model: "gemini-2.5-flash", inputTokens: 100_000, outputTokens: 1_000 });
    // flash: $0.30/M in, $2.50/M out → 0.03 + 0.0025 ≈ $0.0325 → 3 cents
    expect(cost.cents).toBe(3);
  });

  it("zero tokens → 0 cents (degenerate)", () => {
    const cost = priceTurn({ model: "claude-haiku-4-5-20251001", inputTokens: 0, outputTokens: 0 });
    expect(cost.cents).toBe(0);
  });

  it("throws for unknown models", () => {
    expect(() => priceTurn({ model: "no-such-model", inputTokens: 1, outputTokens: 1 })).toThrow(
      /unknown_model_in_pricing_json/,
    );
  });
});

describe("InMemoryCostTracker — 10-turn mixed-provider workflow", () => {
  // Designed to exercise every provider in the pricing doc + budget-class
  // diversity. Tokens chosen to be round numbers per turn.
  const SCRIPT: TurnUsage[] = [
    { model: "claude-sonnet-4-6",       inputTokens:  20_000, outputTokens: 4_000 },
    { model: "claude-haiku-4-5-20251001", inputTokens:  8_000, outputTokens: 2_000 },
    { model: "gemini-2.5-pro",          inputTokens:  60_000, outputTokens: 6_000 },
    { model: "gemini-2.5-flash",        inputTokens: 100_000, outputTokens: 1_500 },
    { model: "gpt-5",                   inputTokens:  15_000, outputTokens: 3_000 },
    { model: "gpt-5-mini",              inputTokens:  12_000, outputTokens: 2_500 },
    { model: "claude-sonnet-4-6",       inputTokens:  18_000, outputTokens: 4_500 },
    { model: "claude-opus-4-7",         inputTokens:   5_000, outputTokens: 1_000 },
    { model: "gemini-2.5-pro",          inputTokens:  40_000, outputTokens: 5_000 },
    { model: "claude-sonnet-4-6",       inputTokens:  22_000, outputTokens: 4_000 },
  ];

  it("bucket sums equal Σ priceTurn(turn).cents within 1%", async () => {
    const tracker = new InMemoryCostTracker();
    let referenceCents = 0;
    let referenceIn = 0;
    let referenceOut = 0;

    for (const turn of SCRIPT) {
      await tracker.recordTurn({ workspaceId: "ws", accountId: "ac", turn });
      const c = priceTurn(turn);
      referenceCents += c.cents;
      referenceIn += turn.inputTokens;
      referenceOut += turn.outputTokens;
    }

    expect(tracker.buckets.size).toBe(1);
    const [bucket] = tracker.buckets.values();
    expect(bucket).toBeDefined();
    expect(bucket!.llmCalls).toBe(SCRIPT.length);
    expect(bucket!.tokensInput).toBe(referenceIn);
    expect(bucket!.tokensOutput).toBe(referenceOut);

    // Drift check: |bucket - reference| / reference < 0.01.
    const drift = Math.abs(bucket!.costCents - referenceCents) / Math.max(1, referenceCents);
    expect(drift).toBeLessThan(0.01);
    // Stronger: should be exactly 0 since priceTurn is deterministic.
    expect(bucket!.costCents).toBe(referenceCents);
  });

  it("separate workspaces accumulate into separate buckets", async () => {
    const tracker = new InMemoryCostTracker();
    await tracker.recordTurn({ workspaceId: "ws1", accountId: "ac1", turn: SCRIPT[0]! });
    await tracker.recordTurn({ workspaceId: "ws2", accountId: "ac1", turn: SCRIPT[1]! });
    expect(tracker.buckets.size).toBe(2);
  });

  it("recordTurn returns the priced TurnCost (matches priceTurn)", async () => {
    const tracker = new InMemoryCostTracker();
    const turn = { model: "claude-sonnet-4-6", inputTokens: 1_000, outputTokens: 500 };
    const got = await tracker.recordTurn({ workspaceId: "w", accountId: "a", turn });
    expect(got.cents).toBe(priceTurn(turn).cents);
    expect(got.inputRate).toBe(PRICING.models["claude-sonnet-4-6"]!.input);
  });
});

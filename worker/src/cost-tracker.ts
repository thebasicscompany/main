// Per-turn cost ledger. CLOUD-AGENT-PLAN §13 reconciliation: instead of
// the dropped `run_cost_lines` + `workspace_cost_ledger` tables, the
// worker bumps the existing `usage_tracking` row (PRIMARY KEY workspace_id
// + account_id + date) with a daily aggregate of tokens_input/output,
// llm_calls, cost_cents. Fine-grain per-turn detail is not persisted —
// matches §0.1's "one ledger, not two" intent.

import postgres from "postgres";
import pricingDoc from "../pricing.json" with { type: "json" };

interface PricingDoc {
  models: Record<string, { provider: string; input: number; output: number }>;
}

const PRICING = pricingDoc as PricingDoc;

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TurnCost extends TurnUsage {
  /** Per-1M-token rates at the moment of the turn. */
  inputRate: number;
  outputRate: number;
  /** Cents (rounded to nearest int) for this turn alone. */
  cents: number;
}

export function priceTurn(turn: TurnUsage): TurnCost {
  const entry = PRICING.models[turn.model];
  if (!entry) throw new Error(`unknown_model_in_pricing_json: ${turn.model}`);
  // $/1M tokens × tokens / 1_000_000 → dollars. ×100 → cents. Round to int.
  const inputDollars = (entry.input * turn.inputTokens) / 1_000_000;
  const outputDollars = (entry.output * turn.outputTokens) / 1_000_000;
  const cents = Math.round((inputDollars + outputDollars) * 100);
  return {
    ...turn,
    inputRate: entry.input,
    outputRate: entry.output,
    cents,
  };
}

export interface CostTracker {
  recordTurn(input: {
    workspaceId: string;
    accountId: string;
    turn: TurnUsage;
  }): Promise<TurnCost>;
}

/** In-memory accumulator for tests + dry-runs. */
export class InMemoryCostTracker implements CostTracker {
  /** key = `${workspaceId}|${accountId}|${date}` */
  readonly buckets = new Map<
    string,
    { tokensInput: number; tokensOutput: number; llmCalls: number; costCents: number }
  >();

  async recordTurn(input: {
    workspaceId: string;
    accountId: string;
    turn: TurnUsage;
  }): Promise<TurnCost> {
    const cost = priceTurn(input.turn);
    const date = new Date().toISOString().slice(0, 10);
    const key = `${input.workspaceId}|${input.accountId}|${date}`;
    const cur = this.buckets.get(key) ?? { tokensInput: 0, tokensOutput: 0, llmCalls: 0, costCents: 0 };
    cur.tokensInput += cost.inputTokens;
    cur.tokensOutput += cost.outputTokens;
    cur.llmCalls += 1;
    cur.costCents += cost.cents;
    this.buckets.set(key, cur);
    return cost;
  }
}

/** Postgres impl — UPSERTs into the existing `usage_tracking` daily row. */
export class PgCostTracker implements CostTracker {
  private sql: ReturnType<typeof postgres>;
  constructor(opts: { databaseUrl: string }) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  async recordTurn(input: {
    workspaceId: string;
    accountId: string;
    turn: TurnUsage;
  }): Promise<TurnCost> {
    const cost = priceTurn(input.turn);
    // usage_tracking.date defaults to CURRENT_DATE; tokens_input is bigint,
    // cost_cents is int. We add this turn's contribution; the row is
    // created on first turn of the day.
    await this.sql`
      INSERT INTO public.usage_tracking
        (workspace_id, account_id, date, tokens_input, tokens_output, llm_calls, cost_cents)
      VALUES
        (${input.workspaceId}, ${input.accountId}, CURRENT_DATE,
         ${cost.inputTokens}, ${cost.outputTokens}, 1, ${cost.cents})
      ON CONFLICT (workspace_id, account_id, date) DO UPDATE
         SET tokens_input  = public.usage_tracking.tokens_input  + EXCLUDED.tokens_input,
             tokens_output = public.usage_tracking.tokens_output + EXCLUDED.tokens_output,
             llm_calls     = public.usage_tracking.llm_calls     + EXCLUDED.llm_calls,
             cost_cents    = public.usage_tracking.cost_cents    + EXCLUDED.cost_cents
    `;
    return cost;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

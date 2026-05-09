// CLOUD-AGENT-PLAN §6.2 budget enforcement. Before each turn the runner
// calls BudgetGate.check(workspaceId, accountId) which:
//   - reads workspaces.agent_settings.dailyCostCeilingCents
//   - reads today's usage_tracking row (the C.2 cost tracker bumps it)
//   - returns usedPct, plus shouldWarn (first cross above 0.8) and exceeded
//
// Runner side:
//   - usedPct ≥ 1.0  → emit run_completed with status='budget_exceeded' and stop the run
//   - usedPct >  0.8 (first time) → emit budget_warning and continue

import postgres from "postgres";

export class BudgetExceededError extends Error {
  constructor(
    public readonly usedCents: number,
    public readonly ceilingCents: number,
  ) {
    super(`budget_exceeded: ${usedCents}¢ used / ${ceilingCents}¢ ceiling`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetCheck {
  usedCents: number;
  ceilingCents: number | null;
  /** 0.0–1.0; >1.0 if exceeded; null if no ceiling configured. */
  usedPct: number | null;
  /** True if the runner should emit budget_warning this turn. */
  shouldWarn: boolean;
  /** True if the runner must hard-stop (also throws on the next call). */
  exceeded: boolean;
}

export interface BudgetGate {
  check(input: { workspaceId: string; accountId: string }): Promise<BudgetCheck>;
}

interface BudgetGateState {
  warned: boolean;
}

interface BudgetSource {
  getCeilingCents(workspaceId: string): Promise<number | null>;
  getTodayUsedCents(workspaceId: string, accountId: string): Promise<number>;
}

/**
 * Stateful BudgetGate — keeps an in-memory `warned` flag per (workspace,
 * account) so we don't re-emit budget_warning on every turn after we
 * cross 0.8 once. The flag is per-process; on worker restart the runner
 * may emit a duplicate warning, which is acceptable (better than missed).
 */
export class StatefulBudgetGate implements BudgetGate {
  private warned = new Map<string, BudgetGateState>();
  constructor(private source: BudgetSource) {}

  async check(input: { workspaceId: string; accountId: string }): Promise<BudgetCheck> {
    const ceiling = await this.source.getCeilingCents(input.workspaceId);
    const used = await this.source.getTodayUsedCents(input.workspaceId, input.accountId);
    if (ceiling === null || ceiling <= 0) {
      return { usedCents: used, ceilingCents: null, usedPct: null, shouldWarn: false, exceeded: false };
    }
    const usedPct = used / ceiling;
    const exceeded = usedPct >= 1.0;
    const key = `${input.workspaceId}|${input.accountId}`;
    const state = this.warned.get(key) ?? { warned: false };
    let shouldWarn = false;
    if (usedPct > 0.8 && !state.warned && !exceeded) {
      shouldWarn = true;
      state.warned = true;
      this.warned.set(key, state);
    }
    return { usedCents: used, ceilingCents: ceiling, usedPct, shouldWarn, exceeded };
  }

  /** Test helper — reset warning state. */
  __resetForTests(): void {
    this.warned.clear();
  }
}

/** Postgres source — production wiring. */
export class PgBudgetSource implements BudgetSource {
  private sql: ReturnType<typeof postgres>;
  constructor(opts: { databaseUrl: string }) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  async getCeilingCents(workspaceId: string): Promise<number | null> {
    const rows = await this.sql<Array<{ ceiling: number | null }>>`
      SELECT (agent_settings->>'dailyCostCeilingCents')::int AS ceiling
        FROM public.workspaces
       WHERE id = ${workspaceId}
       LIMIT 1
    `;
    return rows[0]?.ceiling ?? null;
  }

  async getTodayUsedCents(workspaceId: string, accountId: string): Promise<number> {
    const rows = await this.sql<Array<{ cost_cents: number }>>`
      SELECT cost_cents
        FROM public.usage_tracking
       WHERE workspace_id = ${workspaceId}
         AND account_id   = ${accountId}
         AND date         = CURRENT_DATE
       LIMIT 1
    `;
    return rows[0]?.cost_cents ?? 0;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** In-memory source — tests + dry-runs. */
export class InMemoryBudgetSource implements BudgetSource {
  private ceilings = new Map<string, number>();
  private used = new Map<string, number>();

  setCeiling(workspaceId: string, cents: number | null): void {
    if (cents === null) this.ceilings.delete(workspaceId);
    else this.ceilings.set(workspaceId, cents);
  }

  setUsed(workspaceId: string, accountId: string, cents: number): void {
    this.used.set(`${workspaceId}|${accountId}`, cents);
  }

  addUsed(workspaceId: string, accountId: string, cents: number): void {
    const k = `${workspaceId}|${accountId}`;
    this.used.set(k, (this.used.get(k) ?? 0) + cents);
  }

  async getCeilingCents(workspaceId: string): Promise<number | null> {
    return this.ceilings.get(workspaceId) ?? null;
  }

  async getTodayUsedCents(workspaceId: string, accountId: string): Promise<number> {
    return this.used.get(`${workspaceId}|${accountId}`) ?? 0;
  }
}

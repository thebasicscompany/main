// CLOUD-AGENT-PLAN §6.2 — provider routing matrix.
// `selectModel(turnContext)` picks a model + fallback chain for the next
// LLM call. Inputs: turnKind, imageCount, recentFailures, budget %, and
// workspace overrides (preferredProvider, forbiddenModels). Output: a
// ModelHandle that opencode passes to the Vercel AI SDK.

import pricingDoc from "../../pricing.json" with { type: "json" };

export type Provider = "anthropic" | "google" | "openai";
export type TurnKind =
  | "plan"
  | "act"
  | "read"
  | "summarize"
  | "classify"
  | "recover";

export interface ModelHandle {
  provider: Provider;
  model: string;
  /** Ordered list of fallbacks the caller rotates through on 429/5xx. */
  fallbacks: ModelHandle[];
  /** Reason this entry was picked (matrix row + any override applied). */
  reason: string;
  /** True when budget pressure forced a downshift; runner emits budget_warning. */
  downshifted?: boolean;
  /** Live unit prices ($ per 1M tokens). */
  pricing: { input: number; output: number };
}

export interface SelectModelInput {
  turnKind: TurnKind;
  imageCount?: number;
  payloadSize?: number;
  recentFailures?: ReadonlyArray<{ provider: Provider; reason: string }>;
  workspaceBudgetUsedPct?: number;
  workspaceOverrides?: {
    preferredProvider?: Provider;
    forbiddenModels?: ReadonlyArray<string>;
  };
}

export class BudgetExceededError extends Error {
  constructor() {
    super("budget_exceeded");
    this.name = "BudgetExceededError";
  }
}

interface PricingDoc {
  models: Record<string, { provider: Provider; input: number; output: number }>;
}

const PRICING = pricingDoc as PricingDoc;

function lookupModel(name: string): { provider: Provider; input: number; output: number } {
  const entry = PRICING.models[name];
  if (!entry) throw new Error(`unknown_model_in_pricing_json: ${name}`);
  return entry;
}

interface RouteRow {
  primary: string;
  fallbacks: string[];
}

/** §6.2 matrix as a literal table — keep in sync with the plan. */
function matrixFor(turnKind: TurnKind, imageCount: number): RouteRow {
  switch (turnKind) {
    case "plan":
      return { primary: "claude-sonnet-4-6", fallbacks: ["gpt-5", "gemini-2.5-pro"] };
    case "act":
      if (imageCount >= 1) {
        return { primary: "claude-sonnet-4-6", fallbacks: ["gemini-2.5-pro"] };
      }
      return { primary: "claude-sonnet-4-6", fallbacks: ["gpt-5", "gemini-2.5-pro"] };
    case "read":
      return { primary: "claude-haiku-4-5-20251001", fallbacks: ["gemini-2.5-flash"] };
    case "classify":
      return { primary: "gemini-2.5-flash", fallbacks: ["claude-haiku-4-5-20251001"] };
    case "summarize":
      return { primary: "gemini-2.5-pro", fallbacks: ["claude-sonnet-4-6"] };
    case "recover":
      return { primary: "claude-sonnet-4-6", fallbacks: [] };
  }
}

/** One downshift tier for budget pressure (>0.8). */
const DOWNSHIFT: Record<string, string> = {
  "claude-sonnet-4-6": "claude-haiku-4-5-20251001",
  "claude-opus-4-7": "claude-sonnet-4-6",
  "gemini-2.5-pro": "gemini-2.5-flash",
  "gpt-5": "gpt-5-mini",
};

/** Workspace's `preferredProvider` substitutes the matching tier. */
function preferenceSwap(model: string, preferred: Provider): string {
  const entry = PRICING.models[model];
  if (!entry || entry.provider === preferred) return model;
  // Crude tier mapping: pick a model from the preferred provider in the
  // same rough cost class.
  const tier = entry.input <= 1.0 ? "low" : entry.input <= 5.0 ? "mid" : "high";
  const candidates: Record<Provider, Record<string, string>> = {
    anthropic: {
      low: "claude-haiku-4-5-20251001",
      mid: "claude-sonnet-4-6",
      high: "claude-opus-4-7",
    },
    google: { low: "gemini-2.5-flash", mid: "gemini-2.5-pro", high: "gemini-2.5-pro" },
    openai: { low: "gpt-5-mini", mid: "gpt-5", high: "gpt-5" },
  };
  return candidates[preferred][tier] ?? model;
}

/** Build a ModelHandle from a model name. */
function handleFor(model: string, reason: string, downshifted = false): ModelHandle {
  const p = lookupModel(model);
  return {
    provider: p.provider,
    model,
    fallbacks: [],
    reason,
    ...(downshifted ? { downshifted: true } : {}),
    pricing: { input: p.input, output: p.output },
  };
}

export function selectModel(input: SelectModelInput): ModelHandle {
  const usedPct = input.workspaceBudgetUsedPct ?? 0;
  if (usedPct >= 1.0) throw new BudgetExceededError();

  const imageCount = input.imageCount ?? 0;
  const row = matrixFor(input.turnKind, imageCount);

  const forbidden = new Set(input.workspaceOverrides?.forbiddenModels ?? []);
  const failedProviders = new Set(
    (input.recentFailures ?? []).map((f) => f.provider),
  );

  // Build the candidate chain: primary, then fallbacks.
  const chain: string[] = [row.primary, ...row.fallbacks];

  // Apply preferredProvider if it would change the primary's provider AND
  // the preferred swap isn't forbidden.
  if (input.workspaceOverrides?.preferredProvider) {
    const swapped = preferenceSwap(chain[0]!, input.workspaceOverrides.preferredProvider);
    if (!forbidden.has(swapped)) chain[0] = swapped;
  }

  // Filter forbiddenModels.
  let candidates = chain.filter((m) => !forbidden.has(m));

  // Prefer entries whose provider hasn't recently failed; if any survive
  // we promote those, otherwise we stick with the original order so the
  // caller still has someone to call.
  const nonFailed = candidates.filter((m) => !failedProviders.has(lookupModel(m).provider));
  if (nonFailed.length > 0) candidates = nonFailed;

  if (candidates.length === 0) {
    throw new Error("no_eligible_model — every option was forbidden or recently failed");
  }

  // Budget-aware downshift (>0.8 used → primary becomes its downshift tier
  // when one exists; emit budget_warning at the runner site).
  let downshifted = false;
  let primary = candidates[0]!;
  if (usedPct > 0.8) {
    const ds = DOWNSHIFT[primary];
    if (ds && !forbidden.has(ds)) {
      primary = ds;
      downshifted = true;
    }
  }

  const reason = [
    `matrix:${input.turnKind}${imageCount >= 1 ? "+image" : ""}`,
    input.workspaceOverrides?.preferredProvider ? `preferred=${input.workspaceOverrides.preferredProvider}` : null,
    forbidden.size > 0 ? `forbidden=${[...forbidden].join(",")}` : null,
    failedProviders.size > 0 ? `recently_failed=${[...failedProviders].join(",")}` : null,
    downshifted ? "downshift_budget" : null,
  ]
    .filter(Boolean)
    .join("; ");

  const fallbacks = candidates
    .filter((m) => m !== primary)
    .map((m) => handleFor(m, "fallback"));

  return { ...handleFor(primary, reason, downshifted), fallbacks };
}

/** Test-only escape hatch — surface live pricing without re-importing JSON. */
export function _pricingForTest(): PricingDoc {
  return PRICING;
}

// Tool framework for the cloud-agent worker (CLOUD-AGENT-PLAN §7.5).
// `defineTool` is the single authoring surface for every tool the worker
// exposes to opencode; the OC adapter (worker/src/tools/oc-adapter.ts)
// turns the result into the format opencode wants at runtime.

import { z, type ZodTypeAny } from "zod";

/** Cost class used by §6 routing + ledger heuristics. */
export type ToolCost = "low" | "medium" | "high";

/** Result shapes a tool can return — opencode-friendly + worker-friendly. */
export type ToolResult =
  | { kind: "text"; text: string }
  | { kind: "json"; json: unknown }
  | { kind: "image"; b64: string; mimeType?: string }
  | { kind: "error"; message: string };

export interface ToolDefinition<P extends ZodTypeAny, Ctx, R extends ToolResult> {
  /** Stable name, snake_case. Must match `^[a-z][a-z0-9_]{0,63}$`. */
  readonly name: string;
  readonly description: string;
  /** Zod schema for the model-supplied input. */
  readonly params: P;
  /**
   * Whether the tool mutates external state (file write, navigation, click,
   * SQL write). Drives the §18 approval middleware: when `requiresApproval`
   * is unset, defaults to `mutating === true`.
   */
  readonly mutating: boolean;
  /** Override the default approval gating decision. */
  readonly requiresApproval?: boolean;
  /** Cost class — feeds the §6.2 router and the per-run cost ledger. */
  readonly cost: ToolCost;
  /** The actual implementation. */
  readonly execute: (input: z.infer<P>, ctx: Ctx) => Promise<R>;
}

/**
 * Author a tool. Generic over the param schema, runtime context, and
 * return shape so callers retain full type safety.
 */
export function defineTool<P extends ZodTypeAny, Ctx, R extends ToolResult>(
  def: ToolDefinition<P, Ctx, R>,
): ToolDefinition<P, Ctx, R> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) {
    throw new Error(`tool name '${def.name}' must match /^[a-z][a-z0-9_]{0,63}$/`);
  }
  return def;
}

/** Tool registry — name → definition. Used by the OC adapter at boot. */
export type ToolRegistry<Ctx> = Map<string, ToolDefinition<ZodTypeAny, Ctx, ToolResult>>;

export function registerTools<Ctx>(
  ...tools: ReadonlyArray<ToolDefinition<ZodTypeAny, Ctx, ToolResult>>
): ToolRegistry<Ctx> {
  const reg: ToolRegistry<Ctx> = new Map();
  for (const t of tools) {
    if (reg.has(t.name)) {
      throw new Error(`duplicate tool registration: ${t.name}`);
    }
    reg.set(t.name, t);
  }
  return reg;
}

/**
 * Decide whether a call to `tool` should pause the run for an approval
 * row in `pending_approvals`. Honors explicit override; otherwise defers
 * to the mutating flag.
 */
export function toolRequiresApproval(tool: {
  mutating: boolean;
  requiresApproval?: boolean;
}): boolean {
  return tool.requiresApproval ?? tool.mutating;
}

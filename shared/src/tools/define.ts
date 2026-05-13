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
  | { kind: "image"; b64: string; mimeType?: string; s3Key?: string; signedUrl?: string; byteLength?: number }
  | { kind: "error"; message: string };

/**
 * C.2 — per-call approval decision returned by a tool's `approval`
 * inspector. When `required: true`, the worker pauses on the
 * approvals.gate Postgres NOTIFY channel, writes an `approvals` row,
 * and emits an `approval_requested` activity event. `expiresInSeconds`
 * lets a tool override the default 4-hour TTL (e.g. SMS approvals
 * might want 30 min). `reason` becomes the human-facing label in the
 * approval prompt.
 */
export interface ToolApprovalDecision {
  required: boolean;
  reason?: string;
  expiresInSeconds?: number;
}

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
  /**
   * C.2 — per-call approval inspector. Takes the parsed args and
   * returns `{required, reason?, expiresInSeconds?}`. When set, this
   * supersedes the static `requiresApproval` + `mutating` defaults at
   * the per-call level. C.4 wires this into the worker's gate; here we
   * only declare the shape so C.3 can start populating it across the
   * sensitive tools without coupling to the gate implementation.
   */
  readonly approval?: (args: z.infer<P>) => ToolApprovalDecision;
  /** Cost class — feeds the §6.2 router and the per-run cost ledger. */
  readonly cost: ToolCost;
  /**
   * E.7 — coarse classification used by the dry-run interceptor. When set
   * to `'mutating-outbound'`, the worker's dry-run mode (cloud_runs.dry_run
   * = true) records the call into `cloud_runs.dry_run_actions` instead of
   * executing it. `composio_call` does NOT carry a static tag because
   * mutating-ness varies per toolSlug; the interceptor computes it
   * dynamically from args + the B.8 denylist regex set.
   *
   * Read-only tools (browser navigation, screenshot, list-style Composio
   * calls) intentionally have no `effects` tag — dry-run executes them
   * normally so the preview shows what the agent would have seen.
   */
  readonly effects?: "mutating-outbound";
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

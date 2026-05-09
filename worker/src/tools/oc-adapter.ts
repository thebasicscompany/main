// Adapter from `@basics/shared`'s defineTool format to the shape opencode
// expects when registering tools at session boot. CLOUD-AGENT-PLAN §7.5.
//
// opencode (sst/opencode) is the headless agent runtime running as the
// `:7000` sidecar. It accepts tool definitions with this minimum shape:
//
//   {
//     name: string,
//     description: string,
//     parameters: <JSON Schema>,
//     execute: async (input) => <result>
//   }
//
// — the same shape Anthropic + OpenAI tool-calling APIs use, which opencode
// normalizes internally. We convert each defineTool's zod params to JSON
// Schema via `zod.toJSONSchema` (zod 4) and wrap `execute` with a context
// resolver supplied at adapter-construction time.

import {
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
} from "@basics/shared";
import { z, type ZodTypeAny } from "zod";

export interface OpencodeToolJson {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** opencode-side: invoked with the validated input; returns the tool result. */
  execute: (input: unknown) => Promise<ToolResult>;
  /** Annotations the worker-side approval middleware reads before calling. */
  meta: {
    mutating: boolean;
    requiresApproval: boolean;
    cost: "low" | "medium" | "high";
  };
}

export interface OcAdapterOptions<Ctx> {
  /** Resolves the per-call context (run id, session, publishers, …). */
  resolveContext: () => Ctx | Promise<Ctx>;
  /**
   * Hook invoked when the model sends an arg that fails zod validation.
   * Default: rethrows the zod error so opencode surfaces it to the model.
   */
  onValidationError?: (toolName: string, err: z.ZodError) => never;
}

/** Build the JSON list opencode registers at session boot. */
export function toOpencodeTools<Ctx>(
  registry: ToolRegistry<Ctx>,
  opts: OcAdapterOptions<Ctx>,
): OpencodeToolJson[] {
  return [...registry.values()].map((t) => toOpencodeTool(t, opts));
}

export function toOpencodeTool<P extends ZodTypeAny, Ctx, R extends ToolResult>(
  tool: ToolDefinition<P, Ctx, R>,
  opts: OcAdapterOptions<Ctx>,
): OpencodeToolJson {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.params) as Record<string, unknown>,
    meta: {
      mutating: tool.mutating,
      requiresApproval: tool.requiresApproval ?? tool.mutating,
      cost: tool.cost,
    },
    execute: async (rawInput: unknown) => {
      const parsed = tool.params.safeParse(rawInput);
      if (!parsed.success) {
        if (opts.onValidationError) {
          opts.onValidationError(tool.name, parsed.error);
        }
        throw parsed.error;
      }
      const ctx = await opts.resolveContext();
      return tool.execute(parsed.data, ctx);
    },
  };
}

// K.4 — `helper_call` — the single registered tool through which the
// LLM invokes any agent-authored helper for this workspace.
//
// Why one tool instead of registering each helper as its own opencode
// tool? opencode's plugin tool surface is fixed at plugin init (before
// session-specific workspaceId is known). One generic dispatcher tool
// lets us hydrate workspace-scoped helpers per session.
//
// Flow:
//   1. LLM calls helper_call({helperName: "lp_score_mutual", args: {...}})
//   2. We look up cloud_agent_helpers WHERE workspace_id=$1 AND name=$2 AND active=true
//   3. Sandbox.runHelper() compiles + executes
//   4. Return result.kind=json with whatever the helper returned, or
//      kind=error on throw / timeout (caller LLM can patch via helper_write
//      with supersedes_helper_id).

import { defineTool } from "@basics/shared";
import { z } from "zod";
import { runHelper, HelperTimeoutError, HelperRuntimeError } from "../helper-runtime/sandbox.js";
import type { WorkerToolContext } from "./context.js";

interface HelperRow {
  id: string;
  helper_version: number;
  body: string;
  args_schema: Record<string, unknown>;
  description: string;
}

export const helper_call = defineTool({
  name: "helper_call",
  description:
    "K.4 — invoke an agent-authored helper module from cloud_agent_helpers. Pass the helper's name and its args object. The helper runs in a sandboxed runtime (Node vm.Script) with restricted ctx (ctx.composio, ctx.browser, ctx.fetch, ctx.sql_read, ctx.log). If the helper throws or times out (5min), the call returns kind:error and you can call composio_call / browser tools directly to do the work, then call helper_write(supersedes_helper_id=...) to patch the broken helper. The list of available helpers + their args_schema is injected into your system prompt as <helpers>.",
  params: z.object({
    helperName: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/, "helperName must be snake_case"),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  mutating: true, // helpers may call mutating tools internally
  requiresApproval: false, // approvals fire at the ctx-injected tool level
  cost: "medium",
  execute: async ({ helperName, args }, ctx: WorkerToolContext) => {
    const sql = ctx.sql;
    if (!sql) {
      return {
        kind: "error" as const,
        message: "helper_call unavailable: ctx.sql is not configured",
      };
    }

    // Look up the active helper for this workspace by name.
    const rows = await sql<HelperRow[]>`
      SELECT id::text AS id,
             helper_version,
             body,
             args_schema,
             description
        FROM public.cloud_agent_helpers
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         AND name = ${helperName}
         AND active = true
       LIMIT 1
    `;
    const helper = rows[0];
    if (!helper) {
      return {
        kind: "error" as const,
        message: `helper not found: no active helper named "${helperName}" in this workspace. Call helper_write to create one, or use composio_call / browser tools directly.`,
      };
    }

    await ctx.publish({
      type: "helper_call_start",
      payload: {
        helperName,
        helperId: helper.id,
        helperVersion: helper.helper_version,
        args,
      },
    });

    const t0 = Date.now();
    try {
      // Build the helper-facing ctx by adapting the worker tool ctx.
      // K.4 keeps this surface tight: composio, sql_read, log, fetch (deny-by-default).
      // browser is injected as an empty object for now — K.5+ will wire
      // the real harness API. Helpers that need browser will fail loudly.
      const result = await runHelper({
        helperId: helper.id,
        helperVersion: helper.helper_version,
        body: helper.body,
        args,
        ctx: {
          composio: async (slug, params) => {
            // Stub: a real impl would call the same composio_call dispatch
            // path that the LLM uses. For K.4 first-cut we return a
            // not-implemented marker so helpers that try this fail loudly
            // and the agent reverts to direct composio_call.
            throw new HelperRuntimeError(
              `helper ctx.composio not yet wired (K.5 follow-up); helpers must call through the LLM for composio in K.4`,
            );
          },
          browser: {} as Record<string, never>,
          fetch: async () => {
            throw new HelperRuntimeError("helper ctx.fetch not enabled (set HELPER_FETCH_ALLOWLIST)");
          },
          sql_read: async (_query, _params) => {
            throw new HelperRuntimeError(
              "helper ctx.sql_read not yet wired (K.5 follow-up)",
            );
          },
          log: (...m: unknown[]) => {
            void ctx.publish({
              type: "helper_log",
              payload: { helperName, message: m.map((x) => String(x)).join(" ") },
            });
          },
        },
      });

      const latencyMs = Date.now() - t0;
      await ctx.publish({
        type: "helper_call_end",
        payload: {
          helperName,
          helperId: helper.id,
          helperVersion: helper.helper_version,
          latencyMs,
          ok: true,
        },
      });
      return { kind: "json" as const, json: result ?? null };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const isTimeout = e instanceof HelperTimeoutError;
      const code = isTimeout ? "timeout" : "runtime_error";
      const message = (e as Error).message;
      await ctx.publish({
        type: "helper_call_end",
        payload: {
          helperName,
          helperId: helper.id,
          helperVersion: helper.helper_version,
          latencyMs,
          ok: false,
          code,
          message,
        },
      });
      return {
        kind: "error" as const,
        message: `helper "${helperName}" ${code}: ${message}. Call the underlying tools directly, then helper_write(supersedes_helper_id=${helper.id}) with the fix.`,
      };
    }
  },
});

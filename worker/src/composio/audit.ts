// B.5 — Audit emitter for Composio tool calls.
//
// Every composio_call (B.7) writes two records:
//   1. An `external_action` activity event into cloud_activity. The
//      payload includes a `paramsPreview` — a recursive deep-clone of
//      the call params with any string value under a "sensitive" key
//      replaced by "<redacted>". This is the public-facing record
//      (SSE consumers, dashboards) and must never leak PII / secrets.
//   2. A row in `external_action_audit` (B.2) with the FULL params and
//      result. 30-day TTL via the pg_cron reaper.

import type postgres from "postgres";
import type { WorkerToolContext } from "../tools/context.js";

// Keys whose STRING values get redacted, case-insensitive, exact match
// at any nesting depth. Plan spec verbatim.
const SENSITIVE_KEY_RE = /^(email|body|content|message|password|token|secret|api_key|auth)$/i;

const REDACTED = "<redacted>";

/**
 * Deep-clone `value`, replacing string values whose owning key matches
 * SENSITIVE_KEY_RE with the redaction sentinel. Non-string values are
 * kept as-is so the agent's downstream consumers can still see structure
 * (e.g. `attachments: [{ s3Key: "...", filename: "..." }]` survives).
 */
export function scrubPreview(value: unknown): unknown {
  return scrubInner(value, undefined);
}

function scrubInner(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    if (key !== undefined && SENSITIVE_KEY_RE.test(key)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) {
    // Arrays don't carry a key in the sensitive-key sense — `message: ["a","b"]`
    // should NOT redact the array contents, only future string-typed values
    // under sensitive keys discovered deeper in.
    return value.map((v) => scrubInner(v, undefined));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubInner(v, k);
    }
    return out;
  }
  return value;
}

export interface EmitExternalActionDeps {
  /** Test seam — production injects a postgres client (e.g. the worker's quotaSql). */
  sql: ReturnType<typeof postgres>;
}

/**
 * Emit the `external_action` activity event AND persist the full
 * params+result audit row. Either path failing must not throw — audit
 * is observability, not the critical path for the agent's run.
 */
export async function emitExternalAction(
  ctx: WorkerToolContext,
  toolSlug: string,
  paramsFull: unknown,
  result: unknown,
  deps: EmitExternalActionDeps,
): Promise<void> {
  const paramsPreview = scrubPreview(paramsFull);

  // Activity event — public-facing. Redacted preview only.
  try {
    await ctx.publish({
      type: "external_action",
      payload: {
        kind: "external_action",
        toolSlug,
        paramsPreview,
        // Don't echo the result into the activity event either — Composio
        // tool results can contain arbitrary external API responses with
        // recipient PII. The full result is in external_action_audit.
      },
    });
  } catch (e) {
    console.error("emitExternalAction: activity emit failed", e);
  }

  // Full audit row — internal-only. Service-role writes; RLS SELECT
  // policy restricts reads to workspace members.
  try {
    // postgres-js: use sql.json(...) for jsonb columns. Stringify+cast
    // pattern double-encodes (turns the array/object into a JSON-string
    // scalar rather than the value itself).
    type JsonInput = Parameters<typeof deps.sql.json>[0];
    const paramsJson = deps.sql.json((paramsFull ?? null) as JsonInput);
    const resultJson =
      result === undefined
        ? deps.sql.json(null as unknown as JsonInput)
        : deps.sql.json(result as JsonInput);
    await deps.sql`
      INSERT INTO public.external_action_audit
        (workspace_id, run_id, tool_slug, params_full, result)
      VALUES (
        ${ctx.workspaceId},
        ${ctx.runId},
        ${toolSlug},
        ${paramsJson},
        ${resultJson}
      )
    `;
  } catch (e) {
    console.error("emitExternalAction: audit insert failed", e);
  }
}

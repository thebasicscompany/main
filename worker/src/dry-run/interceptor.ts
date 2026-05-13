// E.7 — Dry-run interceptor.
//
// When a run starts with `cloud_runs.dry_run = true`, the worker has to
// EXECUTE everything the agent does for a real run (read Gmail, browse
// LinkedIn, capture screenshots) — but quarantine the side-effecting calls
// so the operator sees the preview without anything actually being sent.
//
// What gets intercepted:
//   - Tools tagged with `effects: 'mutating-outbound'` in their
//     `defineTool` declaration (currently `send_email`, `send_sms`).
//   - `composio_call` invocations whose `toolSlug` matches a mutating
//     pattern (CREATE, SEND, UPDATE, DELETE, APPEND, INSERT, REPLY,
//     POST, FORWARD, MODIFY, REMOVE, PURGE, WIPE, DROP, INVITE).
//
// What does NOT get intercepted:
//   - Read-only tools (goto_url, screenshot, js, composio_list_tools,
//     non-mutating composio_call slugs, etc.). Dry-run runs them for real
//     so the preview is meaningful.
//
// What replaces the call:
//   - A `dry_run_action` entry appended to a per-run in-memory buffer:
//       { tool, args, intended_at, hypothetical_result }
//   - A `dry_run_action` activity event with the PII-scrubbed preview.
//   - The tool returns `{ kind: 'json', json: { ok: true, dryRun: true,
//                          hypothetical_result: 'dry_run_simulated' } }`.
//
// Buffer lifecycle:
//   - opencode-plugin instantiates one DryRunBuffer per WorkerToolContext
//     when ctx.dryRun is true.
//   - executeWithApproval consults the interceptor BEFORE the approval
//     gate. Approval is bypassed entirely in dry-run mode (gated tools
//     auto-buffer; the preview already tells the operator what would have
//     been sent).
//   - outputs.ts dispatchOutputs uses recordIntercepted directly when
//     ctx.dryRun is true (it bypasses the tool registry).
//   - At run completion, main.ts flushes the buffer into
//     `cloud_runs.dry_run_actions`.

import type postgres from "postgres";
import type { ToolDefinition, ToolResult } from "@basics/shared";
import type { ZodTypeAny } from "zod";
import type { WorkerToolContext } from "../tools/context.js";
import { scrubPreview } from "../composio/audit.js";

/**
 * Slug patterns considered side-effecting for `composio_call`. Broader
 * than B.8's destructive-only denylist — dry-run wants to catch ALL
 * outbound writes, not just dangerous ones.
 */
// Match mutating action verbs anywhere in the slug: as a `_VERB_` infix
// (e.g. GMAIL_SEND_EMAIL), as a `_VERB` suffix (GOOGLESHEETS_VALUES_UPDATE),
// or as a `VERB_…` prefix is implicit in the underscore-bounded patterns.
// CREATE1 catches Composio's auto-disambiguated names (CREATE_GOOGLE_SHEET1).
const MUTATING_COMPOSIO_SLUG_PATTERNS: RegExp[] = [
  /_(CREATE|CREATE1)(_|$)/,
  /_(SEND|REPLY|FORWARD)(_|$)/,
  /_(UPDATE|MODIFY)(_|$)/,
  /_(DELETE|REMOVE|DROP|PURGE|WIPE)(_|$)/,
  /_(APPEND|INSERT|WRITE|UPLOAD|PUT|PATCH)(_|$)/,
  /_(POST|INVITE)(_|$)/,
];

export interface DryRunActionEntry {
  tool: string;
  args: Record<string, unknown>;
  /** ISO-8601 UTC timestamp of when the call was intercepted. */
  intended_at: string;
  /** Always `'dry_run_simulated'` today; reserved for future expansion. */
  hypothetical_result: "dry_run_simulated";
  /** Composio toolSlug when tool === 'composio_call'; undefined otherwise. */
  tool_slug?: string;
}

/**
 * Optional sync-on-append hook. The opencode-plugin wires this to a
 * UPDATE-the-row callback so `cloud_runs.dry_run_actions` reflects the
 * buffer state immediately after each intercept — without it, the row
 * only gets written at SIGTERM-driven teardown, which happens when the
 * pool task dies (up to IDLE_STOP_MS later). The UPDATE is fire-and-
 * forget so it doesn't slow the agent loop down.
 */
export type DryRunBufferFlushHook = (
  entries: readonly DryRunActionEntry[],
) => Promise<void> | void;

export class DryRunBuffer {
  private readonly entries: DryRunActionEntry[] = [];
  private flushHook: DryRunBufferFlushHook | undefined;

  setFlushHook(hook: DryRunBufferFlushHook): void {
    this.flushHook = hook;
  }

  append(entry: DryRunActionEntry): void {
    this.entries.push(entry);
    if (this.flushHook) {
      // Fire-and-forget. Errors are logged and never propagate; the
      // teardown-time flush is the durable backstop.
      Promise.resolve(this.flushHook(this.entries.slice())).catch((e) => {
        console.error("dry-run: live flush hook failed", (e as Error).message);
      });
    }
  }

  snapshot(): readonly DryRunActionEntry[] {
    return this.entries.slice();
  }

  size(): number {
    return this.entries.length;
  }
}

/**
 * Per-call predicate: does this tool execution belong in the dry-run
 * buffer instead of being executed? Pure function — used by tests and
 * the executeWithApproval wrapper.
 */
export function isDryRunMutating(
  def: Pick<ToolDefinition<ZodTypeAny, unknown, ToolResult>, "name" | "effects">,
  args: Record<string, unknown> | undefined,
): boolean {
  if (def.effects === "mutating-outbound") return true;
  if (def.name === "composio_call") {
    const slug = typeof args?.toolSlug === "string" ? args.toolSlug : "";
    if (!slug) return false;
    return MUTATING_COMPOSIO_SLUG_PATTERNS.some((pat) => pat.test(slug));
  }
  return false;
}

/**
 * Append the intended call to the buffer + emit a `dry_run_action`
 * activity event with the PII-scrubbed preview. Returns the simulated
 * tool result that the executor surfaces in place of the real call.
 *
 * Synchronous-ish: publish() is awaited so the SSE stream sees the event
 * in order, but a failure to publish doesn't drop the buffer entry.
 */
export async function recordIntercepted(
  buffer: DryRunBuffer,
  ctx: { publish: (event: { type: string; payload: Record<string, unknown> }) => Promise<void> | void },
  toolName: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): Promise<{ kind: "json"; json: { ok: true; dryRun: true; hypothetical_result: "dry_run_simulated" } }> {
  const intended_at = new Date().toISOString();
  const tool_slug =
    toolName === "composio_call" && typeof args.toolSlug === "string"
      ? args.toolSlug
      : undefined;

  const entry: DryRunActionEntry = {
    tool: toolName,
    args,
    intended_at,
    hypothetical_result: "dry_run_simulated",
    ...(tool_slug ? { tool_slug } : {}),
  };
  buffer.append(entry);

  const argsPreview = scrubPreview(args);
  try {
    await ctx.publish({
      type: "dry_run_action",
      payload: {
        kind: "dry_run_action",
        tool: toolName,
        ...(tool_slug ? { tool_slug } : {}),
        argsPreview,
        intended_at,
        ...(toolCallId ? { toolCallId } : {}),
      },
    });
  } catch (e) {
    console.error("dry-run: failed to publish dry_run_action event", (e as Error).message);
  }

  return {
    kind: "json" as const,
    json: { ok: true, dryRun: true, hypothetical_result: "dry_run_simulated" },
  };
}

/**
 * Flush the buffer into `cloud_runs.dry_run_actions` at run completion.
 * Safe to call with an empty buffer (UPDATE still runs but the column
 * already defaults to '[]', so it's a no-op pattern).
 */
export async function flushBuffer(
  sql: ReturnType<typeof postgres>,
  runId: string,
  buffer: DryRunBuffer,
): Promise<{ ok: true; count: number }> {
  const entries = buffer.snapshot();
  // postgres-js: use `sql.json(value)` for jsonb columns. The naive
  // `${JSON.stringify(value)}::jsonb` pattern double-encodes and stores
  // the value as a JSONB STRING SCALAR — `jsonb_typeof` then returns
  // 'string' and `jsonb_array_length` blows up. See memory note
  // feedback_postgres_js_jsonb_use_sql_json.
  await sql`
    UPDATE public.cloud_runs
       SET dry_run_actions = ${sql.json(entries as unknown as Parameters<typeof sql.json>[0])}
     WHERE id = ${runId}
  `;
  return { ok: true, count: entries.length };
}

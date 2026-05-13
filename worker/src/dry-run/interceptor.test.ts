import { describe, expect, it, vi } from "vitest";
import {
  DryRunBuffer,
  flushBuffer,
  isDryRunMutating,
  recordIntercepted,
  type DryRunActionEntry,
} from "./interceptor.js";
import { executeWithApproval } from "../approvals/with-approval.js";
import type { WorkerToolContext } from "../tools/context.js";

// ─────────────────────────────────────────────────────────────────────────
// isDryRunMutating
// ─────────────────────────────────────────────────────────────────────────

describe("isDryRunMutating", () => {
  it("returns true for tools tagged effects='mutating-outbound'", () => {
    expect(
      isDryRunMutating({ name: "send_email", effects: "mutating-outbound" }, {}),
    ).toBe(true);
    expect(
      isDryRunMutating({ name: "send_sms", effects: "mutating-outbound" }, {}),
    ).toBe(true);
  });

  it("returns false for tools with no effects tag (read-only)", () => {
    expect(isDryRunMutating({ name: "goto_url" }, {})).toBe(false);
    expect(isDryRunMutating({ name: "capture_screenshot" }, {})).toBe(false);
    expect(isDryRunMutating({ name: "js" }, {})).toBe(false);
  });

  describe("composio_call dynamic predicate", () => {
    const cases: Array<[string, boolean]> = [
      ["GMAIL_SEND_EMAIL", true],
      ["GMAIL_CREATE_DRAFT", true],
      ["GMAIL_REPLY_TO_THREAD", true],
      ["GMAIL_FORWARD_THREAD", true],
      ["GOOGLESHEETS_VALUES_UPDATE", true],
      ["GOOGLESHEETS_APPEND_ROW", true],
      ["GOOGLESHEETS_CREATE_GOOGLE_SHEET1", true],
      ["GOOGLECALENDAR_CREATE_EVENT", true],
      ["GOOGLECALENDAR_DELETE_EVENT", true],
      ["SLACK_POST_MESSAGE", true],
      ["LINKEDIN_INVITE_USER", true],
      // Read-only patterns — should NOT match
      ["GMAIL_LIST_THREADS", false],
      ["GMAIL_GET_THREAD", false],
      ["GOOGLESHEETS_BATCH_GET", false],
      ["GOOGLECALENDAR_LIST_EVENTS", false],
      ["SLACK_LIST_CHANNELS", false],
    ];
    it.each(cases)("composio_call(toolSlug=%s) → mutating=%s", (slug, want) => {
      expect(isDryRunMutating({ name: "composio_call" }, { toolSlug: slug })).toBe(want);
    });
    it("returns false when toolSlug is missing", () => {
      expect(isDryRunMutating({ name: "composio_call" }, {})).toBe(false);
      expect(isDryRunMutating({ name: "composio_call" }, undefined)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// recordIntercepted
// ─────────────────────────────────────────────────────────────────────────

describe("recordIntercepted", () => {
  it("appends one entry per call + emits a dry_run_action event", async () => {
    const buffer = new DryRunBuffer();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = { publish: vi.fn(async (e: { type: string; payload: Record<string, unknown> }) => { events.push(e); }) };

    const result = await recordIntercepted(buffer, ctx, "send_sms", { to: "+15551234567", body: "hi" });

    expect(result).toEqual({
      kind: "json",
      json: { ok: true, dryRun: true, hypothetical_result: "dry_run_simulated" },
    });
    expect(buffer.size()).toBe(1);
    const entry = buffer.snapshot()[0]!;
    expect(entry.tool).toBe("send_sms");
    expect(entry.args).toEqual({ to: "+15551234567", body: "hi" });
    expect(entry.hypothetical_result).toBe("dry_run_simulated");
    expect(typeof entry.intended_at).toBe("string");

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("dry_run_action");
    expect(events[0]!.payload.tool).toBe("send_sms");
    expect(events[0]!.payload.kind).toBe("dry_run_action");
  });

  it("PII-scrubs args in the activity preview but keeps the raw entry in the buffer", async () => {
    const buffer = new DryRunBuffer();
    const events: Array<{ payload: Record<string, unknown> }> = [];
    const ctx = { publish: vi.fn(async (e: { payload: Record<string, unknown> }) => { events.push(e); }) };

    await recordIntercepted(buffer, ctx, "send_email", {
      to: "ceo@acme.com",
      subject: "Q4 update",
      body: "Secret strategy goes here.",
    });

    // Buffer keeps the real args for audit.
    expect(buffer.snapshot()[0]!.args.body).toBe("Secret strategy goes here.");
    // Activity preview redacts body (B.5 scrubber pattern); subject is
    // intentionally kept so the operator sees what they would have sent.
    const preview = events[0]!.payload.argsPreview as Record<string, unknown>;
    expect(preview.to).toBe("ceo@acme.com"); // address kept
    expect(preview.body).toBe("<redacted>");
    expect(preview.subject).toBe("Q4 update");
  });

  it("records tool_slug when tool is composio_call", async () => {
    const buffer = new DryRunBuffer();
    const ctx = { publish: vi.fn(async () => undefined) };
    await recordIntercepted(buffer, ctx, "composio_call", { toolSlug: "GMAIL_SEND_EMAIL", params: {} });
    expect(buffer.snapshot()[0]!.tool_slug).toBe("GMAIL_SEND_EMAIL");
  });

  it("does NOT propagate publish errors", async () => {
    const buffer = new DryRunBuffer();
    const ctx = { publish: vi.fn(async () => { throw new Error("publisher boom"); }) };
    const result = await recordIntercepted(buffer, ctx, "send_sms", { to: "+1", body: "x" });
    expect(result.json.ok).toBe(true);
    expect(buffer.size()).toBe(1); // buffer entry survived
  });
});

// ─────────────────────────────────────────────────────────────────────────
// flushBuffer
// ─────────────────────────────────────────────────────────────────────────

describe("flushBuffer", () => {
  function makeFakeSql(state: { lastQuery: string; lastValues: unknown[]; jsonCalls: unknown[] }) {
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.lastQuery = strings.join(" ").toLowerCase();
      state.lastValues = values;
      return undefined;
    }) as unknown as Parameters<typeof flushBuffer>[0];
    // postgres-js sql.json(v) wraps the value into a parameter fragment.
    // For the fake we record what was passed AND return a marker object
    // so the template still binds correctly.
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v) => {
      state.jsonCalls.push(v);
      return { __sql_json__: v };
    };
    return sql;
  }

  it("UPDATEs cloud_runs.dry_run_actions with the buffer contents (via sql.json)", async () => {
    const buffer = new DryRunBuffer();
    buffer.append({
      tool: "send_sms",
      args: { to: "+15551234567", body: "x" },
      intended_at: "2026-05-13T18:50:00Z",
      hypothetical_result: "dry_run_simulated",
    });
    const state = { lastQuery: "", lastValues: [] as unknown[], jsonCalls: [] as unknown[] };
    const sql = makeFakeSql(state);
    const result = await flushBuffer(sql, "run_1", buffer);
    expect(result).toEqual({ ok: true, count: 1 });
    expect(state.lastQuery).toContain("update public.cloud_runs");
    expect(state.lastQuery).toContain("dry_run_actions");
    // The values passed include the runId + the sql.json wrapper.
    expect(state.jsonCalls).toHaveLength(1);
    const passed = state.jsonCalls[0] as DryRunActionEntry[];
    expect(passed).toHaveLength(1);
    expect(passed[0]!.tool).toBe("send_sms");
  });

  it("writes an empty array when nothing was intercepted (sql.json([]))", async () => {
    const buffer = new DryRunBuffer();
    const state = { lastQuery: "", lastValues: [] as unknown[], jsonCalls: [] as unknown[] };
    const sql = makeFakeSql(state);
    const result = await flushBuffer(sql, "run_2", buffer);
    expect(result).toEqual({ ok: true, count: 0 });
    expect(state.jsonCalls[0]).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// executeWithApproval integration: dry-run path skips real execute + gate
// ─────────────────────────────────────────────────────────────────────────

describe("executeWithApproval × dry-run interception", () => {
  function makeCtx(opts: { dryRun: boolean }): WorkerToolContext & { publish: ReturnType<typeof vi.fn> } {
    const base = {
      session: {} as never,
      runId: "run_1",
      workspaceId: "ws_1",
      accountId: "acc_1",
      workspaceRoot: "/tmp",
      publish: vi.fn(async () => undefined),
    };
    return opts.dryRun
      ? { ...base, dryRun: true, dryRunBuffer: new DryRunBuffer() }
      : (base as WorkerToolContext & { publish: ReturnType<typeof vi.fn> });
  }

  const realExecute = vi.fn(async () => ({ kind: "json" as const, json: { ok: true, real: true } }));
  const approvalInspector = vi.fn(() => ({ required: true, reason: "send_sms" }));

  const sendSmsDef = {
    name: "send_sms",
    description: "send",
    params: { parse: (v: unknown) => v } as never,
    mutating: true,
    cost: "low" as const,
    effects: "mutating-outbound" as const,
    approval: approvalInspector,
    execute: realExecute,
  } as never;

  const gotoUrlDef = {
    name: "goto_url",
    description: "navigate",
    params: { parse: (v: unknown) => v } as never,
    mutating: false,
    cost: "low" as const,
    execute: realExecute,
  } as never;

  it("intercepts a mutating-outbound tool in dry-run mode without calling execute or the approval gate", async () => {
    realExecute.mockClear();
    approvalInspector.mockClear();
    const ctx = makeCtx({ dryRun: true });
    const result = await executeWithApproval(
      sendSmsDef,
      "call_1",
      { to: "+15551234567", body: "hi" },
      ctx,
      { sqlTx: {} as never, sqlListen: {} as never, sqlRules: {} as never },
    );
    expect((result as { json: { ok: boolean } }).json.ok).toBe(true);
    expect((result as { json: { dryRun?: boolean } }).json.dryRun).toBe(true);
    expect(realExecute).not.toHaveBeenCalled();
    expect(approvalInspector).not.toHaveBeenCalled();
    expect(ctx.dryRunBuffer?.size()).toBe(1);
  });

  it("passes a read-only tool through to execute in dry-run mode", async () => {
    realExecute.mockClear();
    const ctx = makeCtx({ dryRun: true });
    await executeWithApproval(
      gotoUrlDef,
      "call_1",
      { url: "https://example.com" },
      ctx,
      { sqlTx: {} as never, sqlListen: {} as never, sqlRules: {} as never },
    );
    expect(realExecute).toHaveBeenCalledTimes(1);
    expect(ctx.dryRunBuffer?.size() ?? 0).toBe(0);
  });

  it("does NOT intercept when dry_run is false (normal path)", async () => {
    realExecute.mockClear();
    approvalInspector.mockClear();
    approvalInspector.mockReturnValue({ required: false, reason: "" });
    const ctx = makeCtx({ dryRun: false });
    await executeWithApproval(
      sendSmsDef,
      "call_1",
      { to: "+15551234567", body: "hi" },
      ctx,
      { sqlTx: {} as never, sqlListen: {} as never, sqlRules: {} as never },
    );
    expect(approvalInspector).toHaveBeenCalled();
    expect(realExecute).toHaveBeenCalledTimes(1);
  });
});

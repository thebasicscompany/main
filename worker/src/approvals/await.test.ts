import { describe, expect, it, vi } from "vitest";
import { awaitApproval, type AwaitApprovalDeps } from "./await.js";
import type { WorkerToolContext } from "../tools/context.js";

type Listener = (raw: string) => Promise<void> | void;

/**
 * Fake postgres-js tagged template + sql.json + sql.listen. Captures
 * the INSERT, lets the test fire a NOTIFY synthetically, and serves
 * a programmable status from the post-NOTIFY re-query.
 */
function makeFakePg(state: {
  inserts: Array<unknown[]>;
  statusAtRequery?: "approved" | "denied" | "expired";
  notify: { fire?: Listener };
}): {
  sqlTx: AwaitApprovalDeps["sqlTx"];
  sqlListen: AwaitApprovalDeps["sqlListen"];
} {
  const sqlTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const lower = strings.join(" ").toLowerCase();
    if (lower.includes("insert into public.approvals")) {
      state.inserts.push(values);
      return Promise.resolve([]);
    }
    if (lower.includes("select status from public.approvals")) {
      return Promise.resolve(
        state.statusAtRequery ? [{ status: state.statusAtRequery }] : [],
      );
    }
    return Promise.resolve([]);
  }) as unknown as AwaitApprovalDeps["sqlTx"];
  (sqlTx as unknown as { json: (v: unknown) => unknown }).json = (v) => v;

  const sqlListen = ((_strings: TemplateStringsArray) => Promise.resolve([])) as unknown as AwaitApprovalDeps["sqlListen"];
  (sqlListen as unknown as { listen: (ch: string, h: Listener) => Promise<unknown> }).listen =
    async (_ch: string, h: Listener) => {
      state.notify.fire = h;
      return { unlisten: async () => undefined };
    };

  return { sqlTx, sqlListen };
}

function makeCtx(): {
  ctx: WorkerToolContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    ctx: {
      session: {} as never,
      runId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      accountId: "33333333-3333-3333-3333-333333333333",
      workspaceRoot: "/tmp",
      publish: async (e) => {
        events.push(e);
      },
    },
  };
}

describe("awaitApproval — pause/resume on Postgres NOTIFY", () => {
  it("emits approval_requested with redacted preview and INSERTs a pending row", async () => {
    const state = { inserts: [] as Array<unknown[]>, statusAtRequery: undefined as undefined | "approved" | "denied" | "expired", notify: {} as { fire?: Listener } };
    const pg = makeFakePg(state);
    const { ctx, events } = makeCtx();

    // Fire NOTIFY before the LISTEN handler is even installed —
    // not realistic; instead use vi.useFakeTimers to drive timeout.
    const promise = awaitApproval(
      ctx,
      {
        toolName: "send_email",
        toolCallId: "tc_1",
        args: { to: ["a@x.com", "b@x.com"], subject: "hi", body: "secret message" },
        decision: { required: true, reason: "multi-recipient", expiresInSeconds: 60 },
      },
      pg,
    );

    // Wait a tick for the INSERT to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(state.inserts).toHaveLength(1);

    // Activity event has the preview with `body` redacted by B.5 scrubber.
    const evt = events.find((e) => e.type === "approval_requested");
    expect(evt).toBeDefined();
    expect((evt!.payload.args_preview as Record<string, unknown>).body).toBe("<redacted>");
    expect(evt!.payload.tool_name).toBe("send_email");
    // The raw access token is in the event so a notifier (C.6) can mint a link.
    expect(typeof evt!.payload.access_token).toBe("string");
    expect((evt!.payload.access_token as string).length).toBeGreaterThan(20);

    // Resolve as approved.
    state.statusAtRequery = "approved";
    await state.notify.fire!("");
    const result = await promise;
    expect(result.outcome).toBe("approved");
    expect(typeof result.approvalId).toBe("string");
  });

  it("resolves 'denied' when NOTIFY fires and re-query returns status='denied'", async () => {
    const state = { inserts: [] as Array<unknown[]>, statusAtRequery: "denied" as const, notify: {} as { fire?: Listener } };
    const pg = makeFakePg(state);
    const { ctx } = makeCtx();

    const promise = awaitApproval(
      ctx,
      {
        toolName: "send_sms",
        toolCallId: "tc_2",
        args: { to: "+15551234567", body: "hi" },
        decision: { required: true, reason: "always", expiresInSeconds: 60 },
      },
      pg,
    );
    await new Promise((r) => setTimeout(r, 10));
    await state.notify.fire!("");
    const result = await promise;
    expect(result.outcome).toBe("denied");
  });

  it("resolves 'expired' when wall-clock TTL elapses with no NOTIFY", async () => {
    const state = { inserts: [] as Array<unknown[]>, notify: {} as { fire?: Listener } };
    const pg = makeFakePg(state);
    const { ctx } = makeCtx();
    let now = 1_000_000;
    const promise = awaitApproval(
      ctx,
      {
        toolName: "send_sms",
        toolCallId: "tc_expire",
        args: { to: "+15551234567", body: "hi" },
        decision: { required: true, reason: "always", expiresInSeconds: 0 }, // immediate expiry
      },
      { ...pg, now: () => now },
    );
    const result = await promise;
    expect(result.outcome).toBe("expired");
  });

  it("re-query returning a non-terminal status keeps waiting", async () => {
    const state = { inserts: [] as Array<unknown[]>, statusAtRequery: undefined as undefined | "approved" | "denied" | "expired", notify: {} as { fire?: Listener } };
    const pg = makeFakePg(state);
    const { ctx } = makeCtx();
    const promise = awaitApproval(
      ctx,
      {
        toolName: "bash",
        toolCallId: "tc_b",
        args: { cmd: "rm -rf /tmp/x" },
        decision: { required: true, reason: "bash destructive", expiresInSeconds: 60 },
      },
      pg,
    );
    await new Promise((r) => setTimeout(r, 10));
    // First NOTIFY: status still pending — the handler should NOT resolve.
    state.statusAtRequery = undefined;
    await state.notify.fire!("");
    await new Promise((r) => setTimeout(r, 5));
    // Second NOTIFY: now approved.
    state.statusAtRequery = "approved";
    await state.notify.fire!("");
    const result = await promise;
    expect(result.outcome).toBe("approved");
  });
});

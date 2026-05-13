import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composio_call,
  setComposioCallDeps,
  _resetComposioCallSemaphoresForTests,
} from "./composio_call.js";
import type { WorkerToolContext } from "./context.js";
import type {
  ComposioConnectedAccount,
  ComposioTool,
} from "@basics/shared";
import type { PgComposioToolCache } from "../composio/cache.js";

function ctxWith(opts?: {
  accounts?: Array<[string, ComposioConnectedAccount]>;
  cache?: Partial<PgComposioToolCache>;
  auditSql?: WorkerToolContext["composio"] extends infer C
    ? C extends { auditSql?: infer S }
      ? S
      : never
    : never;
}): {
  ctx: WorkerToolContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  auditInserts: Array<unknown[]>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const auditInserts: Array<unknown[]> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (
      strings.join(" ").toLowerCase().includes(
        "insert into public.external_action_audit",
      )
    ) {
      auditInserts.push(values);
    }
    return Promise.resolve([]);
  }) as unknown as WorkerToolContext["composio"] extends infer C
    ? C extends { auditSql?: infer S }
      ? S
      : never
    : never;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  return {
    events,
    auditInserts,
    ctx: {
      session: {} as never,
      runId: "run_test",
      workspaceId: "ws_test",
      accountId: "acct_test",
      workspaceRoot: "/tmp",
      publish: async (e) => {
        events.push(e);
      },
      composio: {
        accountsByToolkit: new Map(opts?.accounts ?? []),
        cache: opts?.cache as PgComposioToolCache | undefined,
        auditSql: opts?.auditSql ?? sql,
      },
    },
  };
}

beforeEach(() => {
  _resetComposioCallSemaphoresForTests();
});

afterEach(() => {
  setComposioCallDeps(null);
});

describe("composio_call — (a) no connection", () => {
  it("returns no_connection + emits connection_expired when toolkit has no active account", async () => {
    const { ctx, events, auditInserts } = ctxWith({ accounts: [] });
    const execute = vi.fn();
    setComposioCallDeps({ client: { executeTool: execute } });
    const result = await composio_call.execute(
      { toolSlug: "GMAIL_LIST_THREADS", params: {} },
      ctx,
    );
    const json = (result as { kind: "json"; json: { ok: false; error: { code: string } } }).json;
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("no_connection");
    expect(execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("connection_expired");
    expect(auditInserts).toHaveLength(0);
  });
});

describe("composio_call — (b)+(f) happy path + audit", () => {
  it("calls executeTool with correct args and emits external_action + writes audit", async () => {
    const { ctx, events, auditInserts } = ctxWith({
      accounts: [["gmail", { id: "acc_gmail_1" }]],
    });
    const execute = vi.fn(async () => ({ threads: [{ id: "t1" }] }));
    setComposioCallDeps({ client: { executeTool: execute } });

    const result = await composio_call.execute(
      { toolSlug: "GMAIL_LIST_THREADS", params: { max_results: 1 } },
      ctx,
    );
    expect(execute).toHaveBeenCalledWith("GMAIL_LIST_THREADS", {
      userId: "acct_test",
      connectedAccountId: "acc_gmail_1",
      arguments: { max_results: 1 },
    });
    const json = (result as { kind: "json"; json: { ok: true; result: unknown } }).json;
    expect(json.ok).toBe(true);
    expect(json.result).toEqual({ threads: [{ id: "t1" }] });

    // external_action emitted with redacted preview (no sensitive keys here so unchanged)
    const externalEvt = events.find((e) => e.type === "external_action");
    expect(externalEvt).toBeDefined();
    expect(externalEvt!.payload).toMatchObject({
      kind: "external_action",
      toolSlug: "GMAIL_LIST_THREADS",
      paramsPreview: { max_results: 1 },
    });

    // audit row written
    expect(auditInserts).toHaveLength(1);
  });
});

describe("composio_call — (c) connection expired", () => {
  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
    [400, "CONNECTION_EXPIRED: token revoked"],
  ])(
    "status=%s message=%s → emits connection_expired and invalidates account",
    async (status, message) => {
      const { ctx, events } = ctxWith({
        accounts: [["gmail", { id: "acc_gmail_1" }]],
      });
      const err = Object.assign(new Error(message), { status });
      const execute = vi.fn(async () => {
        throw err;
      });
      setComposioCallDeps({ client: { executeTool: execute } });

      const result = await composio_call.execute(
        { toolSlug: "GMAIL_LIST_THREADS", params: {} },
        ctx,
      );
      const json = (result as { kind: "json"; json: { ok: false; error: { code: string } } }).json;
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("connection_expired");

      const connEvt = events.find((e) => e.type === "connection_expired");
      expect(connEvt).toBeDefined();
      expect(connEvt!.payload).toMatchObject({
        kind: "connection_expired",
        toolSlug: "GMAIL_LIST_THREADS",
        toolkitSlug: "gmail",
      });

      // The in-context account map is invalidated for that toolkit.
      expect(ctx.composio!.accountsByToolkit.has("gmail")).toBe(false);
    },
  );
});

describe("composio_call — (d) rate limit", () => {
  it("status=429 → emits external_rate_limit and returns rate_limited error", async () => {
    const { ctx, events } = ctxWith({
      accounts: [["gmail", { id: "acc_gmail_1" }]],
    });
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    setComposioCallDeps({
      client: {
        executeTool: vi.fn(async () => {
          throw err;
        }),
      },
    });
    const result = await composio_call.execute(
      { toolSlug: "GMAIL_LIST_THREADS", params: {} },
      ctx,
    );
    const json = (result as { kind: "json"; json: { ok: false; error: { code: string } } }).json;
    expect(json.error.code).toBe("rate_limited");
    expect(events.find((e) => e.type === "external_rate_limit")).toBeDefined();
  });
});

describe("composio_call — (e) schema mismatch retry", () => {
  it("400/422 schema error → invalidates cache, refreshes, retries once successfully", async () => {
    const invalidate = vi.fn(async () => undefined);
    const refresh = vi.fn(async (): Promise<ComposioTool[]> => [
      { slug: "GMAIL_LIST_THREADS" },
    ]);
    const { ctx, auditInserts } = ctxWith({
      accounts: [["gmail", { id: "acc_gmail_1" }]],
      cache: {
        invalidateCache: invalidate as unknown as PgComposioToolCache["invalidateCache"],
        refreshCache: refresh as unknown as PgComposioToolCache["refreshCache"],
      },
    });
    let callIdx = 0;
    setComposioCallDeps({
      client: {
        executeTool: vi.fn(async () => {
          callIdx += 1;
          if (callIdx === 1) {
            throw Object.assign(new Error("invalid_field max_results: expected int"), {
              status: 400,
            });
          }
          return { threads: [] };
        }),
      },
    });

    const result = await composio_call.execute(
      { toolSlug: "GMAIL_LIST_THREADS", params: { max_results: 1 } },
      ctx,
    );
    const json = (result as { kind: "json"; json: { ok: true; recoveredFromSchemaMismatch: boolean } }).json;
    expect(json.ok).toBe(true);
    expect(json.recoveredFromSchemaMismatch).toBe(true);
    expect(invalidate).toHaveBeenCalledWith("ws_test", "gmail");
    expect(refresh).toHaveBeenCalledWith("ws_test", "gmail");
    expect(callIdx).toBe(2);
    // Audit fires once at the end (after success).
    expect(auditInserts).toHaveLength(1);
  });

  it("schema retry that fails again → returns schema_mismatch error", async () => {
    const { ctx } = ctxWith({
      accounts: [["gmail", { id: "acc_gmail_1" }]],
      cache: {
        invalidateCache: vi.fn(async () => undefined) as unknown as PgComposioToolCache["invalidateCache"],
        refreshCache: vi.fn(async () => []) as unknown as PgComposioToolCache["refreshCache"],
      },
    });
    setComposioCallDeps({
      client: {
        executeTool: vi.fn(async () => {
          throw Object.assign(new Error("invalid_field"), { status: 400 });
        }),
      },
    });
    const result = await composio_call.execute(
      { toolSlug: "GMAIL_LIST_THREADS", params: {} },
      ctx,
    );
    const json = (result as { kind: "json"; json: { ok: false; error: { code: string } } }).json;
    expect(json.error.code).toBe("schema_mismatch");
  });
});

describe("composio_call — semaphore", () => {
  it("serialises calls per toolkit when max=1", async () => {
    const { ctx } = ctxWith({
      accounts: [["gmail", { id: "acc_gmail_1" }]],
    });
    let inFlight = 0;
    let observedPeak = 0;
    setComposioCallDeps({
      semaphoreMax: 1,
      client: {
        executeTool: vi.fn(async () => {
          inFlight += 1;
          observedPeak = Math.max(observedPeak, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
          return { ok: true };
        }),
      },
    });
    await Promise.all([
      composio_call.execute({ toolSlug: "GMAIL_LIST_THREADS", params: {} }, ctx),
      composio_call.execute({ toolSlug: "GMAIL_LIST_THREADS", params: {} }, ctx),
      composio_call.execute({ toolSlug: "GMAIL_LIST_THREADS", params: {} }, ctx),
    ]);
    expect(observedPeak).toBe(1);
  });

  it("different toolkits run concurrently (don't share a semaphore)", async () => {
    const { ctx } = ctxWith({
      accounts: [
        ["gmail",          { id: "acc_g" }],
        ["googlecalendar", { id: "acc_c" }],
      ],
    });
    let inFlight = 0;
    let observedPeak = 0;
    setComposioCallDeps({
      semaphoreMax: 1,
      client: {
        executeTool: vi.fn(async () => {
          inFlight += 1;
          observedPeak = Math.max(observedPeak, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight -= 1;
          return {};
        }),
      },
    });
    await Promise.all([
      composio_call.execute({ toolSlug: "GMAIL_LIST_THREADS", params: {} }, ctx),
      composio_call.execute({ toolSlug: "GOOGLECALENDAR_LIST_EVENTS", params: {} }, ctx),
    ]);
    expect(observedPeak).toBe(2);
  });
});

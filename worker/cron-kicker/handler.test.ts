import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sqsSendMock = vi.fn(async (_cmd: unknown) => ({ MessageId: "mock" }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = sqsSendMock; },
  SendMessageCommand: class { input: unknown; constructor(i: unknown) { this.input = i; } },
}));

interface SqlCall { fragment: string; values: unknown[] }
const sqlCalls: SqlCall[] = [];
const sqlResponses: unknown[][] = [];

const sqlTagFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
  sqlCalls.push({ fragment: strings.join("?"), values });
  return Promise.resolve(sqlResponses.shift() ?? []);
};
// postgres-js sql tag also exposes sql.json(...) — the kicker uses it for inputs.
(sqlTagFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
// postgres-js sql.begin(callback) runs queries through a single
// transactional connection. For tests, we just forward to the same
// tag fn so all queries inside the callback still hit sqlCalls.
(sqlTagFn as unknown as { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin =
  async (cb) => cb(sqlTagFn);

vi.mock("postgres", () => ({
  default: () => sqlTagFn,
}));

beforeAll(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.DATABASE_URL_POOLER = "postgres://x";
  process.env.RUNS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000/basics-runs.fifo";
});

beforeEach(() => {
  vi.resetModules();
  sqsSendMock.mockClear();
  sqlCalls.length = 0;
  sqlResponses.length = 0;
});

const AID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("cron-kicker handler — D.6 automation path", () => {
  it("happy path: fetches automation + INSERTs cloud_runs + dispatches SQS", async () => {
    sqlResponses.push([{ id: AID, goal: "process new emails", version: 3, archived_at: null, workspace_id: "ws_uuid", triggers: [{ type: "schedule" }] }]);
    sqlResponses.push([]);  // D.7 debounce check (no recent run)
    sqlResponses.push([{ id: "cag_existing" }]);  // ensureAdHocAgent — SELECT hits
    sqlResponses.push([]);  // INSERT cloud_runs
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID,
      workspaceId: "ws_uuid",
      accountId: "acc_uuid",
      goal: "ignored (kicker reads current automation.goal)",
      triggeredBy: "schedule",
    });
    expect(result.runId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.skipped).toBeUndefined();

    // SQL calls: SELECT automations, debounce SELECT, SELECT cloud_agents, INSERT cloud_runs.
    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls[0]!.fragment).toContain("FROM public.automations");
    expect(sqlCalls[1]!.fragment).toContain("FROM public.cloud_runs");
    expect(sqlCalls[2]!.fragment).toContain("FROM public.cloud_agents");
    expect(sqlCalls[3]!.fragment).toContain("INSERT INTO public.cloud_runs");

    // SQS dispatch shape.
    expect(sqsSendMock).toHaveBeenCalledOnce();
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string; MessageGroupId: string } };
    expect(sent.input.MessageGroupId).toBe("ws_uuid");
    const body = JSON.parse(sent.input.MessageBody) as Record<string, unknown>;
    expect(body.automationId).toBe(AID);
    expect(body.automationVersion).toBe(3);
    expect(body.triggeredBy).toBe("schedule");
    expect(body.goal).toBe("process new emails");
    expect(body.inputs).toEqual({});
  });

  it("skips archived automation (no INSERT, no SQS)", async () => {
    sqlResponses.push([{ id: AID, goal: "x", version: 1, archived_at: new Date().toISOString(), workspace_id: "ws", triggers: [] }]);
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("archived");
    expect(sqsSendMock).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it("skips missing automation (no INSERT, no SQS)", async () => {
    sqlResponses.push([]);
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not_found");
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("creates ad-hoc cloud_agent when missing", async () => {
    sqlResponses.push([{ id: AID, goal: "g", version: 1, archived_at: null, workspace_id: "ws", triggers: [] }]);
    sqlResponses.push([]);                          // D.7 debounce check
    sqlResponses.push([]);                          // SELECT cloud_agents — empty
    sqlResponses.push([{ id: "cag_newly_created" }]);  // INSERT cloud_agents RETURNING
    sqlResponses.push([]);                          // INSERT cloud_runs
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.runId).toBeDefined();
    expect(sqlCalls).toHaveLength(5);
    expect(sqlCalls[3]!.fragment).toContain("INSERT INTO public.cloud_agents");
  });

  it("D.7 debounce: recent run exists → skip + emit trigger_debounced", async () => {
    sqlResponses.push([{ id: AID, goal: "g", version: 1, archived_at: null, workspace_id: "ws", triggers: [{ type: "schedule" }] }]);
    sqlResponses.push([{ id: "recent_run", workspace_id: "ws", account_id: "acc" }]);  // debounce hit
    sqlResponses.push([]);  // INSERT cloud_activity trigger_debounced
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("debounced");
    expect(sqsSendMock).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2]!.fragment).toContain("trigger_debounced");
  });

  it("substitutes vars in the goal before SQS dispatch", async () => {
    sqlResponses.push([{ id: AID, goal: "review {VIDEO_ID}", version: 1, archived_at: null, workspace_id: "ws", triggers: [] }]);
    sqlResponses.push([]);  // D.7 debounce
    sqlResponses.push([{ id: "cag" }]);
    sqlResponses.push([]);
    const { handler } = await import("./handler.js");
    await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
      vars: { VIDEO_ID: "abc123" },
    });
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string } };
    const body = JSON.parse(sent.input.MessageBody) as Record<string, unknown>;
    expect(body.goal).toBe("review abc123");
  });
});

describe("cron-kicker handler — legacy cloud_agents path (unchanged)", () => {
  it("dispatches when given cloudAgentId + goal", async () => {
    sqlResponses.push([]);  // INSERT cloud_runs
    const { handler } = await import("./handler.js");
    const result = await handler({
      cloudAgentId: "cag_legacy",
      workspaceId: "ws",
      accountId: "acc",
      goal: "legacy goal",
    });
    expect(result.runId).toBeDefined();
    expect(sqsSendMock).toHaveBeenCalledOnce();
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageGroupId: string; MessageBody: string } };
    expect(sent.input.MessageGroupId).toBe("ws:default");
    expect(JSON.parse(sent.input.MessageBody).goal).toBe("legacy goal");
  });
});

describe("cron-kicker handler — validation", () => {
  it("throws if neither cloudAgentId nor automationId set", async () => {
    const { handler } = await import("./handler.js");
    await expect(
      handler({ workspaceId: "ws", accountId: "acc", goal: "no id" }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("throws if workspaceId missing", async () => {
    const { handler } = await import("./handler.js");
    await expect(
      handler({ automationId: AID } as unknown as Parameters<typeof handler>[0]),
    ).rejects.toThrow(/workspaceId\/accountId/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// H.1 — SKIP LOCKED + tentative lease
// ──────────────────────────────────────────────────────────────────────────

describe("cron-kicker handler — H.1 SKIP LOCKED + tentative lease", () => {
  it("H.3: claim SELECT applies per-workspace fairness via ROW_NUMBER OVER PARTITION BY workspace_id + FOR UPDATE OF cps SKIP LOCKED", async () => {
    process.env.COMPOSIO_API_KEY = "test_key";
    process.env.POLL_PER_WORKSPACE_CAP = "5";
    sqlResponses.push([]); // SELECT returns no due rows
    const { handler } = await import("./handler.js");
    await handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0]);

    const selectCall = sqlCalls.find((c) =>
      c.fragment.includes("FROM public.composio_poll_state") &&
      c.fragment.toUpperCase().includes("FOR UPDATE OF CPS SKIP LOCKED"),
    );
    expect(selectCall).toBeDefined();
    // ROW_NUMBER window over workspace_id is the H.3 fairness signal.
    expect(selectCall!.fragment.toUpperCase()).toContain("ROW_NUMBER");
    expect(selectCall!.fragment.toUpperCase()).toContain("PARTITION BY WORKSPACE_ID");
    // Per-workspace cap is rendered (the 5 ends up as a postgres-js
    // parameter, not inline literal, so check the values arr).
    expect(selectCall!.values).toContain(5);
    // Outer LIMIT preserves POLL_BATCH_SIZE.
    expect(selectCall!.values).toContain(50);
    delete process.env.POLL_PER_WORKSPACE_CAP;
  });

  it("poll sweep: claim phase uses FOR UPDATE SKIP LOCKED inside sql.begin + bumps next_poll_at lease before adapter runs", async () => {
    process.env.COMPOSIO_API_KEY = "test_key";
    // First sqlResponses entry: the FOR UPDATE SKIP LOCKED SELECT returns
    // one row. Then the tentative-lease UPDATE returns []. Then the
    // adapter is not registered (so the no-adapter branch fires:
    // UPDATE backoff). Total 3 sql calls.
    sqlResponses.push([
      {
        id: "11111111-1111-4111-8111-111111111111",
        automation_id: AID,
        trigger_index: 0,
        toolkit: "unknowntoolkit",
        event: "UNKNOWNTOOLKIT_EVENT",
        filters: {},
        state: {},
        composio_user_id: "user_x",
        connected_account_id: "ca_x",
        consecutive_failures: 0,
      },
    ]);
    sqlResponses.push([]);   // tentative-lease UPDATE
    sqlResponses.push([]);   // no-adapter UPDATE (backoff branch)
    const { handler } = await import("./handler.js");
    const result = (await handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0])) as Record<string, unknown>;
    expect(result.sweep).toBe("poll_composio_triggers");
    expect(result.scanned).toBe(1);

    // Validate the SELECT fragment includes FOR UPDATE OF cps SKIP
    // LOCKED (H.3 changed the bare `FOR UPDATE SKIP LOCKED` to
    // target the composio_poll_state alias inside the fairness CTE).
    const selectCall = sqlCalls.find((c) =>
      c.fragment.includes("FROM public.composio_poll_state") &&
      c.fragment.toUpperCase().includes("FOR UPDATE OF CPS SKIP LOCKED"),
    );
    expect(selectCall).toBeDefined();

    // Validate the tentative-lease UPDATE ran AFTER the SELECT and
    // BEFORE the no-adapter UPDATE — order is critical to the locking
    // contract.
    const leaseCall = sqlCalls.find((c) =>
      c.fragment.includes("UPDATE public.composio_poll_state") &&
      c.fragment.includes("interval '1 second'") &&
      !c.fragment.includes("last_polled_at"),
    );
    expect(leaseCall).toBeDefined();

    const selectIdx = sqlCalls.findIndex((c) => c === selectCall);
    const leaseIdx = sqlCalls.findIndex((c) => c === leaseCall);
    expect(leaseIdx).toBeGreaterThan(selectIdx);
  });

  it("H.2: adapter that times out → row failed within timeout window, sweep continues", async () => {
    process.env.COMPOSIO_API_KEY = "test_key";
    process.env.POLL_ADAPTER_TIMEOUT_MS = "100"; // 100ms for the test
    // Claim returns one row for a registered toolkit. Then the adapter
    // (registered below) hangs forever. The outer code should time out
    // after 100ms, write the failure UPDATE, and return.
    sqlResponses.push([
      {
        id: "11111111-1111-4111-8111-111111111111",
        automation_id: AID,
        trigger_index: 0,
        toolkit: "stubbed_toolkit",
        event: "STUBBED_EVENT",
        filters: {},
        state: {},
        composio_user_id: "u",
        connected_account_id: "ca",
        consecutive_failures: 0,
      },
    ]);
    sqlResponses.push([]);   // lease UPDATE
    sqlResponses.push([]);   // failure backoff UPDATE

    // Register a hanging adapter through the same registry the
    // kicker imports. Re-import the registry so we can register
    // fresh.
    const { registerAdapter, _clearAdapterRegistryForTests } = await import(
      "../src/poll-adapters/index.js"
    );
    _clearAdapterRegistryForTests();
    registerAdapter({
      toolkit: "stubbed_toolkit",
      events: ["STUBBED_EVENT"],
      initialState: async () => ({}),
      poll: () => new Promise(() => { /* never resolves */ }),
    });

    const { handler } = await import("./handler.js");
    const start = Date.now();
    const result = (await handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0])) as Record<string, unknown>;
    const elapsed = Date.now() - start;

    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(1);
    // The whole sweep should complete within timeout + reasonable
    // overhead. 100ms timeout + 200ms test overhead = 300ms ceiling.
    expect(elapsed).toBeLessThan(500);

    // Failure backoff UPDATE fired (last sqlCall after the SELECT +
    // lease).
    const backoffCall = sqlCalls.find((c) =>
      c.fragment.includes("UPDATE public.composio_poll_state") &&
      c.fragment.includes("consecutive_failures") &&
      c.fragment.includes("next_poll_at"),
    );
    expect(backoffCall).toBeDefined();

    _clearAdapterRegistryForTests();
    delete process.env.POLL_ADAPTER_TIMEOUT_MS;
  });

  it("H.2: adapter that throws synchronously → caught + row marked failed", async () => {
    process.env.COMPOSIO_API_KEY = "test_key";
    sqlResponses.push([
      {
        id: "22222222-2222-4222-8222-222222222222",
        automation_id: AID,
        trigger_index: 0,
        toolkit: "throwing_toolkit",
        event: "THROWING_EVENT",
        filters: {},
        state: {},
        composio_user_id: "u",
        connected_account_id: "ca",
        consecutive_failures: 0,
      },
    ]);
    sqlResponses.push([]);   // lease UPDATE
    sqlResponses.push([]);   // failure backoff UPDATE

    const { registerAdapter, _clearAdapterRegistryForTests } = await import(
      "../src/poll-adapters/index.js"
    );
    _clearAdapterRegistryForTests();
    registerAdapter({
      toolkit: "throwing_toolkit",
      events: ["THROWING_EVENT"],
      initialState: async () => ({}),
      poll: async () => {
        throw new Error("adapter blew up synchronously");
      },
    });

    const { handler } = await import("./handler.js");
    const result = (await handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0])) as Record<string, unknown>;
    expect(result.failed).toBe(1);
    expect(result.scanned).toBe(1);

    _clearAdapterRegistryForTests();
  });

  it("H.2: 5-row batch with row-3 timeout → rows 1,2,4,5 still process; row-3 fails", async () => {
    process.env.COMPOSIO_API_KEY = "test_key";
    process.env.POLL_ADAPTER_TIMEOUT_MS = "80";
    const ids = [
      "10000000-1000-4000-8000-000000000001",
      "20000000-2000-4000-8000-000000000002",
      "30000000-3000-4000-8000-000000000003",
      "40000000-4000-4000-8000-000000000004",
      "50000000-5000-4000-8000-000000000005",
    ];
    const rows = ids.map((id, i) => ({
      id,
      automation_id: AID,
      trigger_index: 0,
      toolkit: i === 2 ? "hang_kit" : "fast_kit",
      event: i === 2 ? "HANG_EVENT" : "FAST_EVENT",
      filters: {},
      state: {},
      composio_user_id: "u",
      connected_account_id: "ca",
      consecutive_failures: 0,
    }));
    sqlResponses.push(rows);   // SELECT FOR UPDATE SKIP LOCKED
    sqlResponses.push([]);     // lease UPDATE
    // Each fast row's success path = (no events emitted → no
    // cloud_runs INSERT) + success UPDATE: total 1 SQL per fast row.
    // The hang row: failure backoff UPDATE: 1 SQL.
    for (let i = 0; i < 5; i++) sqlResponses.push([]);

    const { registerAdapter, _clearAdapterRegistryForTests } = await import(
      "../src/poll-adapters/index.js"
    );
    _clearAdapterRegistryForTests();
    registerAdapter({
      toolkit: "fast_kit",
      events: ["FAST_EVENT"],
      initialState: async () => ({}),
      poll: async () => ({ newEvents: [], nextState: { ok: true } }),
    });
    registerAdapter({
      toolkit: "hang_kit",
      events: ["HANG_EVENT"],
      initialState: async () => ({}),
      poll: () => new Promise(() => { /* never resolves */ }),
    });

    const { handler } = await import("./handler.js");
    const start = Date.now();
    const result = (await handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0])) as Record<string, unknown>;
    const elapsed = Date.now() - start;

    expect(result.scanned).toBe(5);
    expect(result.failed).toBe(1);              // only the hang row
    // 4 success path UPDATEs + 1 failure backoff UPDATE.
    const updateCalls = sqlCalls.filter((c) =>
      c.fragment.includes("UPDATE public.composio_poll_state") &&
      c.fragment.includes("last_polled_at"),
    );
    expect(updateCalls).toHaveLength(5);

    // Whole sweep finishes within timeout + per-row overhead.
    // 80ms timeout + 4 fast rows + overhead = ~250ms ceiling.
    expect(elapsed).toBeLessThan(700);

    _clearAdapterRegistryForTests();
    delete process.env.POLL_ADAPTER_TIMEOUT_MS;
  });

  it("two parallel sweeps: each ID is claimed by EXACTLY one invocation (FOR UPDATE SKIP LOCKED contract)", async () => {
    // Simulate two concurrent kicker invocations against a shared
    // pool of 4 due rows. The mock's sql.begin wraps each SELECT in
    // a serialized transaction; the second invocation sees only the
    // rows not already locked (skipped) by the first. We model this
    // by maintaining a shared `claimed` set: each invocation's
    // SELECT returns the subset of due ids not yet in `claimed`,
    // then the UPDATE adds them. The point is to assert that no
    // row ID appears in both invocations' processed sets.
    process.env.COMPOSIO_API_KEY = "test_key";
    const dueIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const allRows = dueIds.map((id) => ({
      id,
      automation_id: AID,
      trigger_index: 0,
      toolkit: "unknowntoolkit",
      event: "UNKNOWNTOOLKIT_EVENT",
      filters: {},
      state: {},
      composio_user_id: "user_x",
      connected_account_id: "ca_x",
      consecutive_failures: 0,
    }));
    const claimed = new Set<string>();

    // Replace the global sqlTagFn behavior with a smarter one that
    // simulates SKIP LOCKED across two parallel transactions.
    // Because handler.ts caches `_sql` lazily, we override by
    // pushing per-call responses but also branching on the fragment.
    // For this test we monkey-patch sqlCalls' resolver via a custom
    // postgres-mock that intercepts SELECT-FOR-UPDATE-SKIP-LOCKED.
    vi.resetModules();
    const localCalls: Array<{ frag: string }> = [];
    const sqlSmartTag = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const frag = strings.join("?");
      localCalls.push({ frag });
      if (frag.toUpperCase().includes("FOR UPDATE OF CPS SKIP LOCKED")) {
        // Return up to half of the unclaimed rows per invocation —
        // simulates contention where invocation 1 grabs the first
        // batch and invocation 2 sees only the leftovers.
        const unclaimed = allRows.filter((r) => !claimed.has(r.id));
        const grab = unclaimed.slice(0, 2);
        for (const r of grab) claimed.add(r.id);
        return Promise.resolve(grab);
      }
      // Every other statement (UPDATE lease, UPDATE backoff): no-op.
      return Promise.resolve([]);
    }) as unknown as {
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
      json: (v: unknown) => unknown;
      begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    sqlSmartTag.json = (v) => v;
    sqlSmartTag.begin = async (cb) => cb(sqlSmartTag);

    vi.doMock("postgres", () => ({ default: () => sqlSmartTag }));
    const { handler } = await import("./handler.js");

    const [resA, resB] = (await Promise.all([
      handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0]),
      handler({ kind: "poll_composio_triggers" } as unknown as Parameters<typeof handler>[0]),
    ])) as Array<Record<string, unknown>>;

    // Each invocation claimed at most 2 rows; together they should
    // have claimed all 4 with NO double-claims (the SKIP LOCKED
    // semantics enforced by the mock).
    expect((resA.scanned as number) + (resB.scanned as number)).toBe(4);
    expect(claimed.size).toBe(4);
  });
});

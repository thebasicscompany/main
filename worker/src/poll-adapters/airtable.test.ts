import { describe, expect, it, vi } from "vitest";
import { airtableAdapter } from "./airtable.js";

interface ExecuteResponse {
  data: { response_data: unknown };
  successful?: boolean;
  error?: string | null;
}

function makeFetch(queues: Record<string, ExecuteResponse[]>): {
  fetchImpl: typeof fetch;
  calls: Array<{ toolSlug: string; args: Record<string, unknown> }>;
} {
  const remaining: Record<string, ExecuteResponse[]> = {};
  for (const [k, v] of Object.entries(queues)) remaining[k] = [...v];
  const calls: Array<{ toolSlug: string; args: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/tools\/execute\/([^?]+)$/);
    const toolSlug = m ? decodeURIComponent(m[1]!) : "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ toolSlug, args: body.arguments as Record<string, unknown> });
    const queue = remaining[toolSlug];
    if (!queue || queue.length === 0) throw new Error(`no canned response for ${toolSlug}`);
    const next = queue.shift()!;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function recordsResp(records: Array<{ id: string; createdTime?: string; fields?: Record<string, unknown> }>): ExecuteResponse {
  return {
    data: { response_data: { records } },
    successful: true,
    error: null,
  };
}

const baseArgs = {
  composioUserId: "op_at",
  connectedAccountId: "ca_airtable_fixture",
  composioApiKey: "test_key",
};

const baseConfig = {
  baseId: "appXYZ",
  tableId: "tblABC",
  viewId: "viwQ",
};

describe("airtable PollAdapter", () => {
  it("registers under 'airtable' for AIRTABLE_NEW_RECORD_TRIGGER", () => {
    expect(airtableAdapter.toolkit).toBe("airtable");
    expect(airtableAdapter.events).toEqual(["AIRTABLE_NEW_RECORD_TRIGGER"]);
  });

  it("initialState anchors at the newest record id from a desc-sorted list", async () => {
    const { fetchImpl, calls } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          { id: "rec3", createdTime: "2026-05-13T11:00:00.000Z" },
          { id: "rec2", createdTime: "2026-05-13T10:00:00.000Z" },
          { id: "rec1", createdTime: "2026-05-13T09:00:00.000Z" },
        ]),
      ],
    });
    const state = await airtableAdapter.initialState({
      ...baseArgs,
      config: baseConfig,
      fetch: fetchImpl,
    });
    expect(state.last_seen_record_id).toBe("rec3");
    expect(state.last_seen_record_ids).toEqual(["rec3", "rec2", "rec1"]);
    expect(calls[0]!.toolSlug).toBe("AIRTABLE_LIST_RECORDS");
    expect(calls[0]!.args).toMatchObject({
      baseId: "appXYZ",
      tableId: "tblABC",
      view: "viwQ",
      sort: [{ field: "createdTime", direction: "desc" }],
    });
  });

  it("initialState: empty table sets last_seen_record_id null", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [recordsResp([])],
    });
    const state = await airtableAdapter.initialState({
      ...baseArgs,
      config: baseConfig,
      fetch: fetchImpl,
    });
    expect(state.last_seen_record_id).toBeNull();
    expect(state.last_seen_record_ids).toEqual([]);
  });

  it("poll: no change emits zero events", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          { id: "rec3", createdTime: "2026-05-13T11:00:00.000Z" },
          { id: "rec2", createdTime: "2026-05-13T10:00:00.000Z" },
        ]),
      ],
    });
    const result = await airtableAdapter.poll(
      { ...baseArgs, config: baseConfig, fetch: fetchImpl },
      {
        last_seen_record_id: "rec3",
        last_seen_record_ids: ["rec3", "rec2"],
      },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_seen_record_id).toBe("rec3");
  });

  it("poll: single new record emits one event with spec-shaped payload", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          {
            id: "rec_new",
            createdTime: "2026-05-13T12:00:00.000Z",
            fields: { Name: "Acme Capital", Stage: "Inbound" },
          },
          { id: "rec3", createdTime: "2026-05-13T11:00:00.000Z" },
          { id: "rec2", createdTime: "2026-05-13T10:00:00.000Z" },
        ]),
      ],
    });
    const result = await airtableAdapter.poll(
      { ...baseArgs, config: baseConfig, fetch: fetchImpl },
      {
        last_seen_record_id: "rec3",
        last_seen_record_ids: ["rec3", "rec2"],
      },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      base_id: "appXYZ",
      table_id: "tblABC",
      view_id: "viwQ",
      record_id: "rec_new",
    });
    const rec = result.newEvents[0]!.payload.record as { id: string; fields: { Name: string } };
    expect(rec.id).toBe("rec_new");
    expect(rec.fields.Name).toBe("Acme Capital");
    expect(result.nextState.last_seen_record_id).toBe("rec_new");
  });

  it("poll: multi-new in same poll emits one event per record, newest-first", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          { id: "rec_n3", createdTime: "2026-05-13T12:30:00.000Z" },
          { id: "rec_n2", createdTime: "2026-05-13T12:20:00.000Z" },
          { id: "rec_n1", createdTime: "2026-05-13T12:10:00.000Z" },
          { id: "rec3", createdTime: "2026-05-13T11:00:00.000Z" },
        ]),
      ],
    });
    const result = await airtableAdapter.poll(
      { ...baseArgs, config: baseConfig, fetch: fetchImpl },
      {
        last_seen_record_id: "rec3",
        last_seen_record_ids: ["rec3", "rec2"],
      },
    );
    expect(result.newEvents).toHaveLength(3);
    expect(result.newEvents.map((e) => e.payload.record_id)).toEqual([
      "rec_n3",
      "rec_n2",
      "rec_n1",
    ]);
    expect(result.nextState.last_seen_record_id).toBe("rec_n3");
  });

  it("poll: boundary record deleted between polls → emits everything fetched (defensive)", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          { id: "rec_z", createdTime: "2026-05-13T13:00:00.000Z" },
          { id: "rec_y", createdTime: "2026-05-13T12:00:00.000Z" },
        ]),
      ],
    });
    const result = await airtableAdapter.poll(
      { ...baseArgs, config: baseConfig, fetch: fetchImpl },
      {
        // Prior boundary was "rec_DELETED" which no longer appears in
        // the response. With no fallback ring, we'd emit everything.
        last_seen_record_id: "rec_DELETED",
        last_seen_record_ids: ["rec_DELETED"],
      },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(result.nextState.last_seen_record_id).toBe("rec_z");
  });

  it("poll: ring of prior ids catches a deleted top boundary but matches an older one", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          { id: "rec_new", createdTime: "2026-05-13T13:00:00.000Z" },
          { id: "rec_b", createdTime: "2026-05-13T12:00:00.000Z" },
          { id: "rec_a", createdTime: "2026-05-13T11:00:00.000Z" },
        ]),
      ],
    });
    const result = await airtableAdapter.poll(
      { ...baseArgs, config: baseConfig, fetch: fetchImpl },
      {
        // Top boundary "rec_top" was deleted. "rec_b" was also in the
        // ring from a prior poll — it serves as a fallback stop.
        last_seen_record_id: "rec_top",
        last_seen_record_ids: ["rec_top", "rec_b", "rec_a"],
      },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload.record_id).toBe("rec_new");
  });

  it("poll: missing baseline (lastSeen null) → silent re-baseline, zero events", async () => {
    const { fetchImpl } = makeFetch({
      AIRTABLE_LIST_RECORDS: [
        recordsResp([
          { id: "rec_first", createdTime: "2026-05-13T14:00:00.000Z" },
          { id: "rec_second", createdTime: "2026-05-13T13:00:00.000Z" },
        ]),
      ],
    });
    const result = await airtableAdapter.poll(
      { ...baseArgs, config: baseConfig, fetch: fetchImpl },
      { last_seen_record_id: null },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_seen_record_id).toBe("rec_first");
    expect(result.nextState.last_seen_record_ids).toEqual(["rec_first", "rec_second"]);
  });

  it("poll: missing baseId throws cleanly (circuit breaker counts it)", async () => {
    await expect(
      airtableAdapter.poll(
        {
          ...baseArgs,
          config: { tableId: "tblABC" },
          fetch: () => Promise.reject(new Error("unused")) as never,
        },
        { last_seen_record_id: "rec_x" },
      ),
    ).rejects.toThrow(/baseId/);
  });

  it("poll: snake_case config keys (base_id, table_id) are also honored", async () => {
    const { fetchImpl, calls } = makeFetch({
      AIRTABLE_LIST_RECORDS: [recordsResp([])],
    });
    await airtableAdapter.poll(
      {
        ...baseArgs,
        config: { base_id: "appSnake", table_id: "tblSnake" },
        fetch: fetchImpl,
      },
      { last_seen_record_id: "rec_x" },
    );
    expect(calls[0]!.args).toMatchObject({ baseId: "appSnake", tableId: "tblSnake" });
  });

  it("poll: filterByFormula is passed through", async () => {
    const { fetchImpl, calls } = makeFetch({
      AIRTABLE_LIST_RECORDS: [recordsResp([])],
    });
    await airtableAdapter.poll(
      {
        ...baseArgs,
        config: { ...baseConfig, filterByFormula: "{Stage} = 'Inbound'" },
        fetch: fetchImpl,
      },
      { last_seen_record_id: "rec_x" },
    );
    expect(calls[0]!.args.filterByFormula).toBe("{Stage} = 'Inbound'");
  });

  it("poll: HTTP error propagates", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      airtableAdapter.poll(
        { ...baseArgs, config: baseConfig, fetch: fetchImpl },
        { last_seen_record_id: "rec_x" },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });
});

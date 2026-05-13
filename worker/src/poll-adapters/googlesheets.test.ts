import { describe, expect, it, vi } from "vitest";
import { googleSheetsAdapter } from "./googlesheets.js";

interface BatchGetResponse {
  data: { response_data: { valueRanges: Array<{ values: unknown[][] }> } };
  successful: boolean;
  error: null;
}

function mockFetch(response: BatchGetResponse): typeof fetch {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return fn as unknown as typeof fetch;
}

function batchGet(values: unknown[][]): BatchGetResponse {
  return {
    data: { response_data: { valueRanges: [{ values }] } },
    successful: true,
    error: null,
  };
}

const baseArgs = {
  composioUserId: "user_op",
  connectedAccountId: "ca_fixture",
  composioApiKey: "test_key",
};

describe("googlesheets PollAdapter", () => {
  it("registers under 'googlesheets' for GOOGLESHEETS_NEW_ROWS_TRIGGER", () => {
    expect(googleSheetsAdapter.toolkit).toBe("googlesheets");
    expect(googleSheetsAdapter.events).toEqual(["GOOGLESHEETS_NEW_ROWS_TRIGGER"]);
  });

  it("initialState counts non-empty rows and stores header when start_row > 1", async () => {
    const state = await googleSheetsAdapter.initialState({
      ...baseArgs,
      config: {
        spreadsheet_id: "sheet_abc",
        sheet_name: "LP_Pipeline",
        start_row: 2,
      },
      fetch: mockFetch(
        batchGet([
          ["name", "company", "title"],
          ["Alice", "Acme", "VP"],
          ["Bob", "Bigco", "Director"],
          // trailing empty rows that Sheets pads — should not count
          ["", "", ""],
          [],
        ]),
      ),
    });
    expect(state).toEqual({
      last_row_count: 3,
      header_row: ["name", "company", "title"],
    });
  });

  it("initialState omits header_row when start_row is 1", async () => {
    const state = await googleSheetsAdapter.initialState({
      ...baseArgs,
      config: { spreadsheet_id: "s1", sheet_name: "Raw", start_row: 1 },
      fetch: mockFetch(batchGet([["one"], ["two"]])),
    });
    expect(state).toEqual({ last_row_count: 2 });
  });

  it("poll: no change emits zero events and preserves baseline", async () => {
    const result = await googleSheetsAdapter.poll(
      {
        ...baseArgs,
        config: { spreadsheet_id: "s1", sheet_name: "Sheet1" },
        fetch: mockFetch(batchGet([["a"], ["b"], ["c"]])),
      },
      { last_row_count: 3 },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState).toEqual({ last_row_count: 3 });
  });

  it("poll: single new row emits exactly one event with Composio-shaped payload", async () => {
    const result = await googleSheetsAdapter.poll(
      {
        ...baseArgs,
        config: {
          spreadsheet_id: "sheet_abc",
          sheet_name: "LP_Pipeline",
          start_row: 2,
        },
        fetch: mockFetch(
          batchGet([
            ["name", "company"],
            ["Alice", "Acme"],
            ["Bob", "Bigco"],
            ["Carol", "Carco"], // new
          ]),
        ),
      },
      { last_row_count: 3, header_row: ["name", "company"] },
    );
    expect(result.newEvents).toHaveLength(1);
    const evt = result.newEvents[0]!;
    expect(evt.payload).toMatchObject({
      row_number: 4,
      row_data: ["Carol", "Carco"],
      sheet_name: "LP_Pipeline",
      spreadsheet_id: "sheet_abc",
      header_row: ["name", "company"],
    });
    expect(typeof evt.payload.detected_at).toBe("string");
    expect(result.nextState).toEqual({
      last_row_count: 4,
      header_row: ["name", "company"],
    });
  });

  it("poll: multiple new rows emit one event per row with sequential row_numbers", async () => {
    const result = await googleSheetsAdapter.poll(
      {
        ...baseArgs,
        config: { spreadsheet_id: "s1", sheet_name: "Sheet1" },
        fetch: mockFetch(
          batchGet([["a"], ["b"], ["c"], ["d"], ["e"]]),
        ),
      },
      { last_row_count: 2 },
    );
    expect(result.newEvents).toHaveLength(3);
    expect(result.newEvents.map((e) => e.payload.row_number)).toEqual([3, 4, 5]);
    expect(result.newEvents.map((e) => e.payload.row_data)).toEqual([
      ["c"],
      ["d"],
      ["e"],
    ]);
    expect(result.nextState.last_row_count).toBe(5);
  });

  it("poll: sheet shrank → no events, no throw, baseline resyncs to current", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await googleSheetsAdapter.poll(
      {
        ...baseArgs,
        config: { spreadsheet_id: "s1", sheet_name: "Sheet1" },
        fetch: mockFetch(batchGet([["a"], ["b"]])),
      },
      { last_row_count: 5 },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_row_count).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("poll: snake_case value_ranges fallback works when Composio normalizes the key", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            response_data: {
              value_ranges: [{ values: [["x"], ["y"], ["z"]] }],
            },
          },
          successful: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const result = await googleSheetsAdapter.poll(
      {
        ...baseArgs,
        config: { spreadsheet_id: "s1", sheet_name: "Sheet1" },
        fetch: fetchImpl,
      },
      { last_row_count: 1 },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(result.nextState.last_row_count).toBe(3);
  });

  it("poll: throws on Composio HTTP error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("internal failure", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      googleSheetsAdapter.poll(
        {
          ...baseArgs,
          config: { spreadsheet_id: "s1", sheet_name: "Sheet1" },
          fetch: fetchImpl,
        },
        { last_row_count: 0 },
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("poll: throws on Composio successful=false envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { response_data: { valueRanges: [] } },
          successful: false,
          error: "Sheet not found",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    await expect(
      googleSheetsAdapter.poll(
        {
          ...baseArgs,
          config: { spreadsheet_id: "missing", sheet_name: "Sheet1" },
          fetch: fetchImpl,
        },
        { last_row_count: 0 },
      ),
    ).rejects.toThrow(/Sheet not found/);
  });

  it("initialState: bad config (missing spreadsheet_id) throws", async () => {
    await expect(
      googleSheetsAdapter.initialState({
        ...baseArgs,
        config: { sheet_name: "Sheet1" },
        fetch: mockFetch(batchGet([])),
      }),
    ).rejects.toThrow(/spreadsheet_id/);
  });
});

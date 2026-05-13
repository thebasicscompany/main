import { describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  PgComposioToolCache,
  type ComposioToolCacheDeps,
} from "./cache.js";

type Row = { tools_json: unknown; fetched_at: string };

interface FakeSqlState {
  rows: Row[];
  selectCalls: number;
  insertCalls: number;
  deleteCalls: number;
  fetched_at_now?: number;
}

// Minimal postgres-js tagged-template stub. Recognises only the three
// queries this cache layer issues: SELECT, INSERT … ON CONFLICT, DELETE.
function makeFakeSql(state: FakeSqlState) {
  const sql = ((strings: TemplateStringsArray) => {
    const joined = strings.join(" ").toLowerCase();
    if (joined.includes("select tools_json")) {
      state.selectCalls += 1;
      return Promise.resolve(state.rows.slice());
    }
    if (joined.includes("insert into public.composio_tool_cache")) {
      state.insertCalls += 1;
      // Behave like ON CONFLICT DO UPDATE — replace any existing row.
      state.rows = [
        {
          tools_json: [{ slug: "GMAIL_TEST_REFRESHED" }],
          fetched_at: new Date(state.fetched_at_now ?? Date.now()).toISOString(),
        },
      ];
      return Promise.resolve(undefined);
    }
    if (joined.includes("delete from public.composio_tool_cache")) {
      state.deleteCalls += 1;
      state.rows = [];
      return Promise.resolve(undefined);
    }
    throw new Error("unexpected sql query");
  }) as unknown as ComposioToolCacheDeps["sql"];
  return sql;
}

type ExtendedState = FakeSqlState;

function fakeListTools(slug = "GMAIL_TEST_REFRESHED") {
  return vi.fn(async () => [{ slug, name: slug }]);
}

describe("PgComposioToolCache", () => {
  it("cache hit within TTL returns cached rows without calling Composio", async () => {
    const state: ExtendedState = {
      rows: [
        {
          tools_json: [{ slug: "GMAIL_CACHED" }],
          fetched_at: new Date(Date.now() - 5_000).toISOString(),
        },
      ],
      selectCalls: 0,
      insertCalls: 0,
      deleteCalls: 0,
    };
    const client = { listTools: fakeListTools() };
    const cache = new PgComposioToolCache({
      sql: makeFakeSql(state),
      client,
    });
    const tools = await cache.getCachedTools("ws_1", "GMAIL");
    expect(tools).toEqual([{ slug: "GMAIL_CACHED" }]);
    expect(state.selectCalls).toBe(1);
    expect(state.insertCalls).toBe(0);
    expect(client.listTools).not.toHaveBeenCalled();
  });

  it("cache miss (no row) calls Composio then writes through", async () => {
    const state: ExtendedState = {
      rows: [],
      selectCalls: 0,
      insertCalls: 0,
      deleteCalls: 0,
    };
    const client = { listTools: fakeListTools() };
    const cache = new PgComposioToolCache({
      sql: makeFakeSql(state),
      client,
    });
    const tools = await cache.getCachedTools("ws_2", "GMAIL");
    expect(tools).toEqual([
      { slug: "GMAIL_TEST_REFRESHED", name: "GMAIL_TEST_REFRESHED" },
    ]);
    expect(client.listTools).toHaveBeenCalledWith({ toolkitSlug: "GMAIL" });
    expect(state.insertCalls).toBe(1);
  });

  it("cache expired (fetched_at older than TTL) refreshes", async () => {
    const state: ExtendedState = {
      rows: [
        {
          tools_json: [{ slug: "STALE" }],
          fetched_at: new Date(Date.now() - (CACHE_TTL_MS + 60_000)).toISOString(),
        },
      ],
      selectCalls: 0,
      insertCalls: 0,
      deleteCalls: 0,
    };
    const client = { listTools: fakeListTools() };
    const cache = new PgComposioToolCache({
      sql: makeFakeSql(state),
      client,
    });
    const tools = await cache.getCachedTools("ws_3", "GMAIL");
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(state.insertCalls).toBe(1);
    expect(tools[0]!.slug).toBe("GMAIL_TEST_REFRESHED");
  });

  it("refreshCache always writes through regardless of cache state", async () => {
    const state: ExtendedState = {
      rows: [
        {
          tools_json: [{ slug: "FRESH" }],
          fetched_at: new Date().toISOString(),
        },
      ],
      selectCalls: 0,
      insertCalls: 0,
      deleteCalls: 0,
    };
    const client = { listTools: fakeListTools() };
    const cache = new PgComposioToolCache({
      sql: makeFakeSql(state),
      client,
    });
    await cache.refreshCache("ws_4", "GITHUB");
    expect(client.listTools).toHaveBeenCalledWith({ toolkitSlug: "GITHUB" });
    expect(state.insertCalls).toBe(1);
    expect(state.selectCalls).toBe(0);
  });

  it("invalidateCache deletes the row", async () => {
    const state: ExtendedState = {
      rows: [
        {
          tools_json: [{ slug: "X" }],
          fetched_at: new Date().toISOString(),
        },
      ],
      selectCalls: 0,
      insertCalls: 0,
      deleteCalls: 0,
    };
    const cache = new PgComposioToolCache({
      sql: makeFakeSql(state),
      client: { listTools: fakeListTools() },
    });
    await cache.invalidateCache("ws_5", "GMAIL");
    expect(state.deleteCalls).toBe(1);
    expect(state.rows).toEqual([]);
  });

  it("invalid stored tools_json falls back to empty array (defensive)", async () => {
    const state: ExtendedState = {
      rows: [
        {
          tools_json: "this should be an array but isn't",
          fetched_at: new Date().toISOString(),
        },
      ],
      selectCalls: 0,
      insertCalls: 0,
      deleteCalls: 0,
    };
    const cache = new PgComposioToolCache({
      sql: makeFakeSql(state),
      client: { listTools: fakeListTools() },
    });
    const tools = await cache.getCachedTools("ws_6", "GMAIL");
    expect(tools).toEqual([]);
  });
});

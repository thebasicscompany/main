import { describe, expect, it } from "vitest";
import {
  extractHost,
  loadStorageStateForUrl,
  markBrowserSiteVerified,
} from "./loader.js";

interface FakeSqlState {
  rows: Array<{ host: string; storage_state_json: unknown }>;
  selectCalls: number;
  updateCalls: number;
  lastWorkspaceId?: string;
  lastHost?: string;
  throwOnSelect?: boolean;
  throwOnUpdate?: boolean;
}

function makeFakeSql(state: FakeSqlState) {
  // Tagged-template stub. Recognises a SELECT and an UPDATE on
  // workspace_browser_sites; throws on anything else so tests stay tight.
  const sql = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const joined = strings.join(" ").toLowerCase();
    if (joined.includes("select host, storage_state_json")) {
      state.selectCalls += 1;
      if (state.throwOnSelect) throw new Error("select boom");
      state.lastWorkspaceId = values[0] as string;
      state.lastHost = values[1] as string;
      const match = state.rows.filter((r) => r.host === state.lastHost);
      return match;
    }
    if (joined.includes("update public.workspace_browser_sites")) {
      state.updateCalls += 1;
      if (state.throwOnUpdate) throw new Error("update boom");
      state.lastWorkspaceId = values[0] as string;
      state.lastHost = values[1] as string;
      return undefined;
    }
    throw new Error(`unexpected sql query: ${joined.slice(0, 80)}`);
  }) as unknown as Parameters<typeof loadStorageStateForUrl>[0];
  return sql;
}

describe("extractHost", () => {
  it("strips a leading www.", () => {
    expect(extractHost("https://www.linkedin.com/in/foo")).toBe("linkedin.com");
  });
  it("leaves bare apex alone", () => {
    expect(extractHost("https://linkedin.com/")).toBe("linkedin.com");
  });
  it("does NOT strip non-www subdomains", () => {
    expect(extractHost("https://jira.acme.com/issues/1")).toBe("jira.acme.com");
  });
  it("lowercases the host", () => {
    expect(extractHost("https://LinkedIn.COM/")).toBe("linkedin.com");
  });
  it("strips a trailing dot", () => {
    expect(extractHost("https://linkedin.com./")).toBe("linkedin.com");
  });
  it("throws on garbage", () => {
    expect(() => extractHost("not a url")).toThrow();
  });
});

describe("loadStorageStateForUrl", () => {
  it("returns null when no row matches", async () => {
    const state: FakeSqlState = { rows: [], selectCalls: 0, updateCalls: 0 };
    const sql = makeFakeSql(state);
    const result = await loadStorageStateForUrl(sql, "ws_1", "https://linkedin.com/in/foo");
    expect(result).toBeNull();
    expect(state.selectCalls).toBe(1);
    expect(state.lastHost).toBe("linkedin.com");
  });

  it("returns the row when one matches (www stripped)", async () => {
    const state: FakeSqlState = {
      rows: [{ host: "linkedin.com", storage_state_json: { cookies: [{ name: "li_at" }] } }],
      selectCalls: 0,
      updateCalls: 0,
    };
    const sql = makeFakeSql(state);
    const result = await loadStorageStateForUrl(sql, "ws_1", "https://www.linkedin.com/in/foo");
    expect(result).toEqual({
      host: "linkedin.com",
      storageState: { cookies: [{ name: "li_at" }] },
    });
    expect(state.lastWorkspaceId).toBe("ws_1");
    expect(state.lastHost).toBe("linkedin.com");
  });

  it("returns null and never throws on an unparseable URL", async () => {
    const state: FakeSqlState = { rows: [], selectCalls: 0, updateCalls: 0 };
    const sql = makeFakeSql(state);
    const result = await loadStorageStateForUrl(sql, "ws_1", "not a url");
    expect(result).toBeNull();
    expect(state.selectCalls).toBe(0); // never hit the DB
  });

  it("returns null and swallows a SELECT failure", async () => {
    const state: FakeSqlState = {
      rows: [],
      selectCalls: 0,
      updateCalls: 0,
      throwOnSelect: true,
    };
    const sql = makeFakeSql(state);
    const result = await loadStorageStateForUrl(sql, "ws_1", "https://linkedin.com/");
    expect(result).toBeNull();
    expect(state.selectCalls).toBe(1);
  });
});

describe("markBrowserSiteVerified", () => {
  it("UPDATEs last_verified_at for the host", async () => {
    const state: FakeSqlState = { rows: [], selectCalls: 0, updateCalls: 0 };
    const sql = makeFakeSql(state);
    await markBrowserSiteVerified(sql, "ws_1", "linkedin.com");
    expect(state.updateCalls).toBe(1);
    expect(state.lastWorkspaceId).toBe("ws_1");
    expect(state.lastHost).toBe("linkedin.com");
  });

  it("swallows UPDATE failure (best-effort)", async () => {
    const state: FakeSqlState = {
      rows: [],
      selectCalls: 0,
      updateCalls: 0,
      throwOnUpdate: true,
    };
    const sql = makeFakeSql(state);
    await expect(markBrowserSiteVerified(sql, "ws_1", "linkedin.com")).resolves.toBeUndefined();
    expect(state.updateCalls).toBe(1);
  });
});

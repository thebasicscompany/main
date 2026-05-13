import { describe, expect, it, vi } from "vitest";
import type { ComposioConnectedAccount } from "@basics/shared";
import { resolveConnectedAccounts } from "./connection-resolver.js";

function acc(
  id: string,
  status: string,
  slug: string | undefined,
): ComposioConnectedAccount {
  return slug === undefined
    ? { id, status }
    : { id, status, toolkit: { slug } };
}

describe("resolveConnectedAccounts", () => {
  it("returns an ACTIVE-only map keyed by toolkit slug", async () => {
    const client = {
      listConnectedAccounts: vi.fn(async () => [
        acc("a", "ACTIVE", "GMAIL"),
        acc("b", "INACTIVE", "SLACK"),
        acc("c", "ACTIVE", "GITHUB"),
      ]),
    };
    const map = await resolveConnectedAccounts("acct_1", { client });
    expect([...map.keys()].sort()).toEqual(["GITHUB", "GMAIL"]);
    expect(map.get("GMAIL")?.id).toBe("a");
  });

  it("dedups multiple ACTIVE accounts for the same toolkit; first wins", async () => {
    const client = {
      listConnectedAccounts: vi.fn(async () => [
        acc("first", "ACTIVE", "GMAIL"),
        acc("second", "ACTIVE", "GMAIL"),
      ]),
    };
    const map = await resolveConnectedAccounts("acct_1", { client });
    expect(map.get("GMAIL")?.id).toBe("first");
  });

  it("skips accounts without a toolkit slug", async () => {
    const client = {
      listConnectedAccounts: vi.fn(async () => [
        acc("a", "ACTIVE", undefined),
        acc("b", "ACTIVE", ""),
      ]),
    };
    const map = await resolveConnectedAccounts("acct_1", { client });
    expect(map.size).toBe(0);
  });

  it("status comparison is case-insensitive (ACTIVE / Active / active)", async () => {
    const client = {
      listConnectedAccounts: vi.fn(async () => [
        acc("a", "active", "GMAIL"),
        acc("b", "Active", "GITHUB"),
      ]),
    };
    const map = await resolveConnectedAccounts("acct_1", { client });
    expect([...map.keys()].sort()).toEqual(["GITHUB", "GMAIL"]);
  });

  it("returns an empty map when the Composio API throws (graceful degradation)", async () => {
    const client = {
      listConnectedAccounts: vi.fn(async () => {
        throw new Error("Composio /connected_accounts failed with HTTP 503");
      }),
    };
    const map = await resolveConnectedAccounts("acct_1", { client });
    expect(map.size).toBe(0);
  });

  it("passes composioUserId through to Composio", async () => {
    const client = {
      listConnectedAccounts: vi.fn(async () => []),
    };
    await resolveConnectedAccounts("acct_xyz", { client });
    expect(client.listConnectedAccounts).toHaveBeenCalledWith("acct_xyz");
  });
});

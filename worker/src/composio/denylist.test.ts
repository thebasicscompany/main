import { describe, expect, it } from "vitest";
import { isDeniedByPolicy, DEFAULT_DENYLIST } from "./denylist.js";

describe("isDeniedByPolicy — default patterns", () => {
  it.each([
    ["GMAIL_DELETE_THREAD", "_DELETE_"],
    ["SLACK_REMOVE_REACTION", "_REMOVE_"],
    ["DB_DROP_TABLE", "_DROP_"],
    ["GMAIL_PURGE_TRASH", "_PURGE_"],
    ["DRIVE_WIPE_FOLDER", "_WIPE_"],
  ])("denies %s by default (%s)", (slug, patternSource) => {
    const d = isDeniedByPolicy(slug, {});
    expect(d.denied).toBe(true);
    if (d.denied) {
      expect(d.source).toBe("default");
      expect(d.pattern).toBe(patternSource);
    }
  });

  it.each([
    "GMAIL_LIST_THREADS",
    "GMAIL_SEND_EMAIL",
    "GMAIL_FETCH_EMAILS",
    "GMAIL_GET_THREAD",
    "GMAIL_CREATE_LABEL",
  ])("allows non-mutating tool %s by default", (slug) => {
    expect(isDeniedByPolicy(slug, {}).denied).toBe(false);
  });

  it("matches case-sensitively — lowercase _delete_ does NOT trigger default", () => {
    // Composio's canonical tool slugs are UPPER_SNAKE; the defaults match
    // exactly that casing. A hypothetical lowercase slug would slip
    // through — documented behaviour.
    expect(isDeniedByPolicy("gmail_delete_thread", {}).denied).toBe(false);
  });
});

describe("isDeniedByPolicy — workspace allow-list", () => {
  it("explicit allow overrides a default match", () => {
    expect(
      isDeniedByPolicy("GMAIL_DELETE_THREAD", {
        composio_denylist_allow: ["GMAIL_DELETE_THREAD"],
      }).denied,
    ).toBe(false);
  });

  it("allow-list is exact-match, not pattern", () => {
    // Allow GMAIL_DELETE_THREAD but not GMAIL_DELETE_LABEL — default
    // still denies the latter.
    const policy = { composio_denylist_allow: ["GMAIL_DELETE_THREAD"] };
    expect(isDeniedByPolicy("GMAIL_DELETE_THREAD", policy).denied).toBe(false);
    expect(isDeniedByPolicy("GMAIL_DELETE_LABEL", policy).denied).toBe(true);
  });
});

describe("isDeniedByPolicy — defaults opt-out", () => {
  it("disabled=true skips default patterns entirely", () => {
    expect(
      isDeniedByPolicy("GMAIL_DELETE_THREAD", {
        composio_denylist_disabled: true,
      }).denied,
    ).toBe(false);
  });

  it("disabled=true still applies workspace custom patterns", () => {
    const d = isDeniedByPolicy("GMAIL_LIST_THREADS", {
      composio_denylist_disabled: true,
      composio_denylist: ["GMAIL_LIST_"],
    });
    expect(d.denied).toBe(true);
    if (d.denied) expect(d.source).toBe("workspace");
  });
});

describe("isDeniedByPolicy — workspace custom patterns", () => {
  it("adds workspace patterns on top of defaults", () => {
    const policy = { composio_denylist: ["GMAIL_SEND_"] };
    const d = isDeniedByPolicy("GMAIL_SEND_EMAIL", policy);
    expect(d.denied).toBe(true);
    if (d.denied) {
      expect(d.source).toBe("workspace");
      expect(d.pattern).toBe("GMAIL_SEND_");
    }
  });

  it("invalid regex patterns are silently skipped (never block on garbage)", () => {
    const policy = { composio_denylist: ["(unclosed group", "GMAIL_SEND_"] };
    const d = isDeniedByPolicy("GMAIL_SEND_EMAIL", policy);
    expect(d.denied).toBe(true);
  });

  it("returns first matching pattern", () => {
    const policy = { composio_denylist: ["FOO_", "GMAIL_SEND_"] };
    const d = isDeniedByPolicy("GMAIL_SEND_EMAIL", policy);
    expect(d.denied).toBe(true);
    if (d.denied) expect(d.pattern).toBe("GMAIL_SEND_");
  });
});

describe("DEFAULT_DENYLIST sanity", () => {
  it("exposes the documented 5 patterns", () => {
    expect(DEFAULT_DENYLIST).toHaveLength(5);
    expect(DEFAULT_DENYLIST.map((r) => r.source).sort()).toEqual([
      "_DELETE_",
      "_DROP_",
      "_PURGE_",
      "_REMOVE_",
      "_WIPE_",
    ]);
  });
});

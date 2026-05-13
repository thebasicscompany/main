import { describe, expect, it, vi } from "vitest";
import { scrubPreview, emitExternalAction } from "./audit.js";
import type { WorkerToolContext } from "../tools/context.js";

describe("scrubPreview — recursive PII redaction", () => {
  it("redacts top-level sensitive string keys (plan spec list)", () => {
    const input = {
      email: "foo@example.com",
      body: "secret message",
      content: "<html>x</html>",
      message: "ping",
      password: "hunter2",
      token: "tk_xxx",
      secret: "shh",
      api_key: "bas_live_…",
      auth: "Bearer …",
      // Non-string sensitive key: structure preserved.
      to: "alice@example.com",
    };
    const out = scrubPreview(input) as Record<string, unknown>;
    expect(out.email).toBe("<redacted>");
    expect(out.body).toBe("<redacted>");
    expect(out.content).toBe("<redacted>");
    expect(out.message).toBe("<redacted>");
    expect(out.password).toBe("<redacted>");
    expect(out.token).toBe("<redacted>");
    expect(out.secret).toBe("<redacted>");
    expect(out.api_key).toBe("<redacted>");
    expect(out.auth).toBe("<redacted>");
    // `to` is NOT in the sensitive list per the plan; preserve it.
    expect(out.to).toBe("alice@example.com");
  });

  it("redacts nested sensitive keys (plan example)", () => {
    const input = { message: { to: "foo", body: "secret" } };
    const out = scrubPreview(input) as { message: Record<string, unknown> };
    // The TOP-level `message` is a string-key check; but its value here
    // is an object so the key-rule doesn't apply at this level. The
    // nested `body` is the one that should be redacted per the example.
    expect(out.message.to).toBe("foo");
    expect(out.message.body).toBe("<redacted>");
  });

  it("recurses through arrays of objects", () => {
    const input = {
      recipients: [
        { name: "Alice", email: "alice@x.com", body: "msg1" },
        { name: "Bob",   email: "bob@x.com",   body: "msg2" },
      ],
    };
    const out = scrubPreview(input) as {
      recipients: Array<Record<string, unknown>>;
    };
    expect(out.recipients[0]!.email).toBe("<redacted>");
    expect(out.recipients[0]!.body).toBe("<redacted>");
    expect(out.recipients[0]!.name).toBe("Alice");
    expect(out.recipients[1]!.email).toBe("<redacted>");
  });

  it("is case-insensitive on key names (EMAIL / Email / email)", () => {
    const out = scrubPreview({
      EMAIL: "a", Email: "b", email: "c",
      TOKEN: "x", Token: "y", token: "z",
    }) as Record<string, string>;
    expect(out.EMAIL).toBe("<redacted>");
    expect(out.Email).toBe("<redacted>");
    expect(out.email).toBe("<redacted>");
    expect(out.TOKEN).toBe("<redacted>");
  });

  it("preserves non-string values under sensitive keys (numbers, arrays, null)", () => {
    const input = {
      // password as a number — schema-mismatch fixture, but we don't want
      // to lie about the type by returning '<redacted>' (a string). Keep
      // the original; the audit row still has the full thing.
      password: 12345,
      token: null,
      message: ["a", "b"],
      body: { nested_body: "secret" },
    };
    const out = scrubPreview(input) as Record<string, unknown>;
    expect(out.password).toBe(12345);
    expect(out.token).toBeNull();
    expect(out.message).toEqual(["a", "b"]);
    // Nested `body` IS a string key with a string-only direct value? No —
    // here `body` holds an object so the value isn't redacted at this
    // level, but `nested_body` inside it doesn't match the sensitive list
    // so the inner string survives. This is the documented behaviour.
    expect((out.body as { nested_body: string }).nested_body).toBe("secret");
  });

  it("does NOT redact strings inside arrays under a sensitive key (plan-compliant; documented behaviour)", () => {
    // Plan says "string VALUES whose KEYS match" — an array is not a string,
    // so its contents pass through. The full audit row in
    // external_action_audit still captures the unscrubbed array.
    const out = scrubPreview({ body: ["secret1", "secret2"] }) as {
      body: string[];
    };
    expect(out.body).toEqual(["secret1", "secret2"]);
  });

  it("returns primitives unchanged at the top level", () => {
    expect(scrubPreview("hello")).toBe("hello");
    expect(scrubPreview(42)).toBe(42);
    expect(scrubPreview(null)).toBeNull();
    expect(scrubPreview(undefined)).toBeUndefined();
  });

  it("does not mutate the original input (deep-clone semantics)", () => {
    const input = { email: "foo@example.com", nested: { body: "x" } };
    const out = scrubPreview(input) as Record<string, unknown>;
    expect(out).not.toBe(input);
    expect((out.nested as { body: string }).body).toBe("<redacted>");
    expect(input.email).toBe("foo@example.com");
    expect(input.nested.body).toBe("x");
  });
});

function makeCtx(): {
  ctx: WorkerToolContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    ctx: {
      runId: "run_test",
      workspaceId: "ws_test",
      accountId: "acct_test",
      workspaceRoot: "/tmp",
      session: {} as never,
      publish: async (e) => {
        events.push(e);
      },
    },
  };
}

function fakeSql() {
  const inserts: Array<unknown[]> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join(" ").toLowerCase().includes("insert into public.external_action_audit")) {
      inserts.push(values);
    }
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof emitExternalAction>[4]["sql"];
  return { sql, inserts };
}

describe("emitExternalAction", () => {
  it("emits external_action activity event with paramsPreview redacted", async () => {
    const { ctx, events } = makeCtx();
    const { sql } = fakeSql();
    await emitExternalAction(
      ctx,
      "GMAIL_SEND_EMAIL",
      { to: "x@y.com", subject: "hi", body: "secret stuff" },
      { ok: true, threadId: "t_1" },
      { sql },
    );
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("external_action");
    expect(evt.payload).toMatchObject({
      kind: "external_action",
      toolSlug: "GMAIL_SEND_EMAIL",
      paramsPreview: {
        to: "x@y.com",
        subject: "hi",
        body: "<redacted>",
      },
    });
    // Result is intentionally NOT included in the activity payload —
    // Composio results can include arbitrary external PII.
    expect(evt.payload.result).toBeUndefined();
  });

  it("writes the full params + result to external_action_audit", async () => {
    const { ctx, events } = makeCtx();
    const { sql, inserts } = fakeSql();
    await emitExternalAction(
      ctx,
      "SLACK_POST",
      { channel: "C1", message: "hello team" },
      { ts: "123.456" },
      { sql },
    );
    expect(inserts).toHaveLength(1);
    const [workspaceId, runId, toolSlug, paramsJson, resultJson] = inserts[0]!;
    expect(workspaceId).toBe("ws_test");
    expect(runId).toBe("run_test");
    expect(toolSlug).toBe("SLACK_POST");
    expect(JSON.parse(paramsJson as string)).toEqual({
      channel: "C1",
      message: "hello team",
    });
    expect(JSON.parse(resultJson as string)).toEqual({ ts: "123.456" });
    // Activity preview still redacts `message`.
    const evt = events[0]!;
    expect((evt.payload.paramsPreview as { message: string }).message).toBe("<redacted>");
  });

  it("handles a null result without crashing", async () => {
    const { ctx } = makeCtx();
    const { sql, inserts } = fakeSql();
    await emitExternalAction(
      ctx,
      "GMAIL_LIST_THREADS",
      { maxResults: 1 },
      undefined,
      { sql },
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![4]).toBeNull();
  });

  it("does not throw if the activity emit fails", async () => {
    const { ctx } = makeCtx();
    ctx.publish = async () => {
      throw new Error("DB unavailable");
    };
    const { sql, inserts } = fakeSql();
    await emitExternalAction(ctx, "X", {}, {}, { sql });
    // Audit write still attempted.
    expect(inserts).toHaveLength(1);
  });

  it("does not throw if the audit insert fails", async () => {
    const { ctx, events } = makeCtx();
    const sql = ((strings: TemplateStringsArray) => {
      if (strings.join(" ").toLowerCase().includes("insert into")) {
        return Promise.reject(new Error("pg down"));
      }
      return Promise.resolve([]);
    }) as unknown as Parameters<typeof emitExternalAction>[4]["sql"];
    await emitExternalAction(ctx, "X", {}, {}, { sql });
    // Activity emit still fires.
    expect(events).toHaveLength(1);
  });
});

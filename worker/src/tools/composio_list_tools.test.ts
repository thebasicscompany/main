import { describe, expect, it, vi } from "vitest";
import { composio_list_tools } from "./composio_list_tools.js";
import type { WorkerToolContext } from "./context.js";
import type { PgComposioToolCache } from "../composio/cache.js";
import type { ComposioConnectedAccount, ComposioTool } from "@basics/shared";

function makeCtx(opts?: {
  accounts?: Array<[string, ComposioConnectedAccount]>;
  cachedTools?: ComposioTool[];
  cacheError?: Error;
  cache?: boolean;
}): WorkerToolContext {
  const accountsByToolkit = new Map<string, ComposioConnectedAccount>(
    opts?.accounts ?? [],
  );
  const cache = opts?.cache === false
    ? undefined
    : ({
        getCachedTools: vi.fn(async () => {
          if (opts?.cacheError) throw opts.cacheError;
          return opts?.cachedTools ?? [];
        }),
      } as unknown as PgComposioToolCache);
  return {
    session: {} as never,
    runId: "run_test",
    workspaceId: "ws_test",
    accountId: "acct_test",
    workspaceRoot: "/tmp",
    publish: async () => undefined,
    composio: { accountsByToolkit, cache },
  };
}

describe("composio_list_tools — toolkits mode (no toolkit param)", () => {
  it("returns the workspace's connected toolkits, sorted alphabetically", async () => {
    const ctx = makeCtx({
      accounts: [
        ["gmail",          { id: "acc_g" }],
        ["googlecalendar", { id: "acc_c" }],
        ["github",         { id: "acc_h" }],
      ],
    });
    const result = await composio_list_tools.execute({}, ctx);
    const json = (result as { kind: "json"; json: Record<string, unknown> }).json;
    expect(json.mode).toBe("toolkits");
    expect(json.count).toBe(3);
    const toolkits = json.toolkits as Array<{ slug: string; connectedAccountId: string }>;
    expect(toolkits.map((t) => t.slug)).toEqual(["github", "gmail", "googlecalendar"]);
    expect(toolkits.find((t) => t.slug === "gmail")?.connectedAccountId).toBe("acc_g");
  });

  it("returns an empty list when nothing is connected", async () => {
    const ctx = makeCtx({ accounts: [] });
    const result = await composio_list_tools.execute({}, ctx);
    const json = (result as { kind: "json"; json: Record<string, unknown> }).json;
    expect(json.count).toBe(0);
    expect(json.toolkits).toEqual([]);
  });
});

describe("composio_list_tools — toolkit mode (cached tool list)", () => {
  const sampleTools: ComposioTool[] = [
    {
      slug: "GMAIL_SEND_EMAIL",
      name: "Send Email",
      description: "Send an email via the user's Gmail account.",
      input_schema: { type: "object", properties: { to: { type: "string" } } },
    },
    {
      slug: "GMAIL_LIST_THREADS",
      name: "List Threads",
      description: "List Gmail threads.",
      parameters: { type: "object" },
    },
    {
      slug: "GMAIL_GET_THREAD",
      name: "Get Thread",
      description: "Get a single thread by id.",
    },
  ];

  it("returns shaped tools with paramSchema from input_schema/parameters/schema", async () => {
    const ctx = makeCtx({ cachedTools: sampleTools });
    const result = await composio_list_tools.execute({ toolkit: "GMAIL" }, ctx);
    const json = (result as { kind: "json"; json: Record<string, unknown> }).json;
    expect(json.mode).toBe("toolkit");
    expect(json.toolkit).toBe("gmail");
    expect(json.count).toBe(3);
    const tools = json.tools as Array<{
      slug: string;
      name?: string;
      paramSchema?: unknown;
    }>;
    expect(tools[0]!.slug).toBe("GMAIL_SEND_EMAIL");
    expect(tools[0]!.paramSchema).toEqual({
      type: "object",
      properties: { to: { type: "string" } },
    });
    // 2nd uses `parameters`
    expect(tools[1]!.paramSchema).toEqual({ type: "object" });
    // 3rd has no schema → omitted from output
    expect(tools[2]!.paramSchema).toBeUndefined();
  });

  it("lowercases the toolkit before cache lookup so uppercase GMAIL works", async () => {
    const ctx = makeCtx({ cachedTools: sampleTools });
    const cacheSpy = ctx.composio!.cache!.getCachedTools as ReturnType<typeof vi.fn>;
    await composio_list_tools.execute({ toolkit: "GMAIL" }, ctx);
    expect(cacheSpy).toHaveBeenCalledWith("ws_test", "gmail");
  });

  it("filters by query (substring, case-insensitive, matches slug/name/description)", async () => {
    const ctx = makeCtx({ cachedTools: sampleTools });
    const r1 = await composio_list_tools.execute(
      { toolkit: "gmail", query: "thread" },
      ctx,
    );
    const j1 = (r1 as { kind: "json"; json: Record<string, unknown> }).json;
    expect(j1.count).toBe(2);
    const slugs = (j1.tools as Array<{ slug: string }>).map((t) => t.slug).sort();
    expect(slugs).toEqual(["GMAIL_GET_THREAD", "GMAIL_LIST_THREADS"]);

    const r2 = await composio_list_tools.execute(
      { toolkit: "gmail", query: "SEND" }, // case-insensitive on slug
      ctx,
    );
    expect(
      ((r2 as { kind: "json"; json: { tools: Array<{ slug: string }> } })
        .json.tools)[0]?.slug,
    ).toBe("GMAIL_SEND_EMAIL");
  });

  it("returns totalBeforeFilter so callers can tell when a query trimmed results", async () => {
    const ctx = makeCtx({ cachedTools: sampleTools });
    const r = await composio_list_tools.execute(
      { toolkit: "gmail", query: "nothing_matches_this" },
      ctx,
    );
    const j = (r as { kind: "json"; json: Record<string, unknown> }).json;
    expect(j.count).toBe(0);
    expect(j.totalBeforeFilter).toBe(3);
  });
});

describe("composio_list_tools — error surfaces", () => {
  it("returns composio_unavailable when ctx.composio is missing", async () => {
    const ctx: WorkerToolContext = {
      session: {} as never,
      runId: "r",
      workspaceId: "w",
      accountId: "a",
      workspaceRoot: "/tmp",
      publish: async () => undefined,
    };
    const r = await composio_list_tools.execute({}, ctx);
    const j = (r as { kind: "json"; json: { ok: false; error: { code: string } } }).json;
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe("composio_unavailable");
  });

  it("returns cache_unavailable when toolkit-mode is requested but cache is absent", async () => {
    const ctx = makeCtx({ accounts: [["gmail", { id: "g" }]], cache: false });
    const r = await composio_list_tools.execute({ toolkit: "gmail" }, ctx);
    const j = (r as { kind: "json"; json: { ok: false; error: { code: string } } }).json;
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe("cache_unavailable");
  });
});

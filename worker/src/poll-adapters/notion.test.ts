import { describe, expect, it, vi } from "vitest";
import {
  notionPageAddedAdapter,
  notionPageAddedToDatabaseAdapter,
  notionCommentsAddedAdapter,
} from "./notion.js";

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

function resp(results: unknown[], hasMore?: boolean, nextCursor?: string): ExecuteResponse {
  return {
    data: {
      response_data: {
        results,
        has_more: hasMore ?? false,
        next_cursor: nextCursor ?? null,
      },
    },
    successful: true,
    error: null,
  };
}

const baseArgs = {
  composioUserId: "op_notion",
  connectedAccountId: "ca_notion_fixture",
  composioApiKey: "test_key",
};

describe("notion PollAdapter — NOTION_PAGE_ADDED_TRIGGER", () => {
  it("registers under toolkit='notion' for the right slug", () => {
    expect(notionPageAddedAdapter.toolkit).toBe("notion");
    expect(notionPageAddedAdapter.events).toEqual(["NOTION_PAGE_ADDED_TRIGGER"]);
  });

  it("initialState anchors last_seen_edited at current time", async () => {
    const state = await notionPageAddedAdapter.initialState({ ...baseArgs, config: {} });
    expect(typeof state.last_seen_edited).toBe("string");
    expect(state.last_seen_page_ids).toEqual([]);
  });

  it("poll: no new pages (all older than high-water)", async () => {
    const { fetchImpl } = makeFetch({
      NOTION_SEARCH: [
        resp([
          { id: "p1", object: "page", last_edited_time: "2026-05-13T08:00:00.000Z" },
          { id: "p2", object: "page", last_edited_time: "2026-05-13T07:00:00.000Z" },
        ]),
      ],
    });
    const result = await notionPageAddedAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_edited: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toEqual([]);
  });

  it("poll: single new page emits payload + advances high-water", async () => {
    const { fetchImpl, calls } = makeFetch({
      NOTION_SEARCH: [
        resp([
          { id: "p_new", object: "page", last_edited_time: "2026-05-13T11:30:00.000Z", url: "https://notion.so/p_new" },
          { id: "p_old", object: "page", last_edited_time: "2026-05-13T09:00:00.000Z" },
        ]),
      ],
    });
    const result = await notionPageAddedAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_edited: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      page_id: "p_new",
      last_edited_time: "2026-05-13T11:30:00.000Z",
    });
    expect(result.nextState.last_seen_edited).toBe("2026-05-13T11:30:00.000Z");
    expect(calls[0]!.args).toMatchObject({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
  });

  it("poll: paginates via next_cursor when has_more", async () => {
    const { fetchImpl, calls } = makeFetch({
      NOTION_SEARCH: [
        resp(
          [{ id: "p_recent", object: "page", last_edited_time: "2026-05-13T12:00:00.000Z" }],
          true,
          "cur_p2",
        ),
        resp([{ id: "p_later", object: "page", last_edited_time: "2026-05-13T12:30:00.000Z" }]),
      ],
    });
    const result = await notionPageAddedAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_edited: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.args).start_cursor).toBe("cur_p2");
  });

  it("poll: boundary-equal page is dropped only if id was previously emitted", async () => {
    const { fetchImpl } = makeFetch({
      NOTION_SEARCH: [
        resp([
          { id: "p_already", object: "page", last_edited_time: "2026-05-13T13:00:00.000Z" },
          { id: "p_new_at_boundary", object: "page", last_edited_time: "2026-05-13T13:00:00.000Z" },
        ]),
      ],
    });
    const result = await notionPageAddedAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_edited: "2026-05-13T13:00:00.000Z", last_seen_page_ids: ["p_already"] },
    );
    expect(result.newEvents).toHaveLength(1);
    expect((result.newEvents[0]!.payload.page as { id: string }).id).toBe("p_new_at_boundary");
  });
});

describe("notion PollAdapter — NOTION_PAGE_ADDED_TO_DATABASE", () => {
  it("registers under toolkit='notion' for the right slug", () => {
    expect(notionPageAddedToDatabaseAdapter.toolkit).toBe("notion");
    expect(notionPageAddedToDatabaseAdapter.events).toEqual(["NOTION_PAGE_ADDED_TO_DATABASE"]);
  });

  it("initialState anchors last_seen_created at now", async () => {
    const state = await notionPageAddedToDatabaseAdapter.initialState({ ...baseArgs, config: {} });
    expect(typeof state.last_seen_created).toBe("string");
  });

  it("poll: missing database_id throws", async () => {
    await expect(
      notionPageAddedToDatabaseAdapter.poll(
        { ...baseArgs, config: {}, fetch: () => Promise.reject(new Error("unused")) as never },
        { last_seen_created: "2026-05-13T10:00:00.000Z" },
      ),
    ).rejects.toThrow(/database_id/);
  });

  it("poll: single new page in database emits payload with database_id", async () => {
    const { fetchImpl, calls } = makeFetch({
      NOTION_QUERY_DATABASE: [
        resp([
          { id: "db_p1", object: "page", created_time: "2026-05-13T14:00:00.000Z", parent: { database_id: "db_X" } },
        ]),
      ],
    });
    const result = await notionPageAddedToDatabaseAdapter.poll(
      { ...baseArgs, config: { database_id: "db_X" }, fetch: fetchImpl },
      { last_seen_created: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      page_id: "db_p1",
      database_id: "db_X",
      created_time: "2026-05-13T14:00:00.000Z",
    });
    expect(calls[0]!.args).toMatchObject({
      database_id: "db_X",
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    });
  });

  it("poll: no new pages (all created_time < lastSeen)", async () => {
    const { fetchImpl } = makeFetch({
      NOTION_QUERY_DATABASE: [
        resp([
          { id: "old1", created_time: "2026-05-12T10:00:00.000Z" },
          { id: "old2", created_time: "2026-05-12T08:00:00.000Z" },
        ]),
      ],
    });
    const result = await notionPageAddedToDatabaseAdapter.poll(
      { ...baseArgs, config: { database_id: "db_X" }, fetch: fetchImpl },
      { last_seen_created: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toEqual([]);
  });
});

describe("notion PollAdapter — NOTION_COMMENTS_ADDED_TRIGGER", () => {
  it("registers under toolkit='notion' for the right slug", () => {
    expect(notionCommentsAddedAdapter.toolkit).toBe("notion");
    expect(notionCommentsAddedAdapter.events).toEqual(["NOTION_COMMENTS_ADDED_TRIGGER"]);
  });

  it("poll: missing block_id throws", async () => {
    await expect(
      notionCommentsAddedAdapter.poll(
        { ...baseArgs, config: {}, fetch: () => Promise.reject(new Error("unused")) as never },
        { last_seen_created: "2026-05-13T10:00:00.000Z" },
      ),
    ).rejects.toThrow(/block_id/);
  });

  it("poll: single new comment emits payload with page_id (block_id)", async () => {
    const { fetchImpl, calls } = makeFetch({
      NOTION_LIST_COMMENTS: [
        resp([
          {
            id: "cmt_A",
            parent: { type: "page_id", page_id: "page_xyz" },
            created_time: "2026-05-13T15:00:00.000Z",
            rich_text: [{ plain_text: "Looks good" }],
          },
        ]),
      ],
    });
    const result = await notionCommentsAddedAdapter.poll(
      { ...baseArgs, config: { block_id: "page_xyz" }, fetch: fetchImpl },
      { last_seen_created: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      comment_id: "cmt_A",
      page_id: "page_xyz",
      created_time: "2026-05-13T15:00:00.000Z",
    });
    expect(calls[0]!.args).toMatchObject({ block_id: "page_xyz" });
  });

  it("poll: no-change when all comments created before last_seen", async () => {
    const { fetchImpl } = makeFetch({
      NOTION_LIST_COMMENTS: [
        resp([
          { id: "cmt_old", created_time: "2026-05-12T10:00:00.000Z" },
        ]),
      ],
    });
    const result = await notionCommentsAddedAdapter.poll(
      { ...baseArgs, config: { block_id: "page_xyz" }, fetch: fetchImpl },
      { last_seen_created: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toEqual([]);
  });

  it("poll: paginates via next_cursor", async () => {
    const { fetchImpl, calls } = makeFetch({
      NOTION_LIST_COMMENTS: [
        resp(
          [{ id: "c1", created_time: "2026-05-13T16:00:00.000Z" }],
          true,
          "cur_c2",
        ),
        resp([{ id: "c2", created_time: "2026-05-13T16:05:00.000Z" }]),
      ],
    });
    const result = await notionCommentsAddedAdapter.poll(
      { ...baseArgs, config: { block_id: "page_xyz" }, fetch: fetchImpl },
      { last_seen_created: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.args).start_cursor).toBe("cur_c2");
  });

  it("poll: HTTP error propagates", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      notionCommentsAddedAdapter.poll(
        { ...baseArgs, config: { block_id: "page_xyz" }, fetch: fetchImpl },
        { last_seen_created: "2026-05-13T10:00:00.000Z" },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });
});

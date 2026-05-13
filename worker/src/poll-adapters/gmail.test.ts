import { describe, expect, it, vi } from "vitest";
import { gmailAdapter } from "./gmail.js";

interface ExecuteResponse {
  data: { response_data: unknown };
  successful?: boolean;
  error?: string | null;
}

type FetchCall = { url: string; toolSlug: string; body: Record<string, unknown> };

/** Build a fake fetch that routes by tool slug to a per-test queue
 *  of canned responses. Each fetch call pops the next response from
 *  the slug's queue. Also records every invocation for assertion. */
function makeFetch(responsesBySlug: Record<string, Array<ExecuteResponse | { httpStatus: number; body: string }>>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queues: Record<string, Array<ExecuteResponse | { httpStatus: number; body: string }>> = {};
  for (const [k, v] of Object.entries(responsesBySlug)) queues[k] = [...v];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/tools\/execute\/([^?]+)$/);
    const toolSlug = m ? decodeURIComponent(m[1]!) : "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, toolSlug, body });
    const queue = queues[toolSlug];
    if (!queue || queue.length === 0) {
      throw new Error(`test fetch: no canned response for ${toolSlug}`);
    }
    const next = queue.shift()!;
    if ("httpStatus" in next) {
      return new Response(next.body, { status: next.httpStatus });
    }
    const payload: ExecuteResponse = {
      data: next.data,
      successful: next.successful ?? true,
      error: next.error ?? null,
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function profileResp(historyId: string): ExecuteResponse {
  return {
    data: { response_data: { emailAddress: "op@example.com", historyId } },
  };
}

function historyResp(args: {
  historyId: string;
  addedMessageIds?: Array<{ id: string; threadId?: string; labelIds?: string[] }>;
  nextPageToken?: string;
}): ExecuteResponse {
  return {
    data: {
      response_data: {
        history: (args.addedMessageIds ?? []).map((m) => ({
          messagesAdded: [{ message: m }],
        })),
        historyId: args.historyId,
        nextPageToken: args.nextPageToken,
      },
    },
  };
}

function messageResp(args: {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  subject: string;
  snippet: string;
  labelIds?: string[];
  internalDate?: string;
  bodyText?: string;
}): ExecuteResponse {
  const headers = [
    { name: "From", value: args.from },
    { name: "Subject", value: args.subject },
  ];
  if (args.to) headers.push({ name: "To", value: args.to });
  const payload: Record<string, unknown> = { headers };
  if (args.bodyText) {
    payload.body = {
      data: Buffer.from(args.bodyText, "utf-8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
    };
  }
  return {
    data: {
      response_data: {
        id: args.id,
        threadId: args.threadId,
        snippet: args.snippet,
        labelIds: args.labelIds ?? ["INBOX", "UNREAD"],
        internalDate: args.internalDate ?? "1715000000000",
        payload,
      },
    },
  };
}

const baseArgs = {
  composioUserId: "op@example.com",
  connectedAccountId: "ca_gmail_fixture",
  composioApiKey: "test_key",
};

describe("gmail PollAdapter", () => {
  it("registers under 'gmail' for GMAIL_NEW_GMAIL_MESSAGE", () => {
    expect(gmailAdapter.toolkit).toBe("gmail");
    expect(gmailAdapter.events).toEqual(["GMAIL_NEW_GMAIL_MESSAGE"]);
  });

  it("initialState returns { start_history_id } from FETCH_USER_PROFILE", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_FETCH_USER_PROFILE: [profileResp("hist_100")],
    });
    const state = await gmailAdapter.initialState({
      ...baseArgs,
      config: {},
      fetch: fetchImpl,
    });
    expect(state).toEqual({ start_history_id: "hist_100" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolSlug).toBe("GMAIL_FETCH_USER_PROFILE");
  });

  it("initialState throws when profile lacks historyId", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_FETCH_USER_PROFILE: [
        { data: { response_data: { emailAddress: "op@example.com" } } },
      ],
    });
    await expect(
      gmailAdapter.initialState({ ...baseArgs, config: {}, fetch: fetchImpl }),
    ).rejects.toThrow(/missing historyId/);
  });

  it("poll: no history changes → zero events, advances historyId", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_LIST_HISTORY: [historyResp({ historyId: "hist_120" })],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { start_history_id: "hist_100" },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState).toEqual({ start_history_id: "hist_120" });
    expect(calls).toHaveLength(1);
  });

  it("poll: single new message emits Composio-shaped payload (no body by default)", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_LIST_HISTORY: [
        historyResp({
          historyId: "hist_200",
          addedMessageIds: [{ id: "msg_A", threadId: "thr_A", labelIds: ["INBOX"] }],
        }),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { start_history_id: "hist_100" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      messageId: "msg_A",
      threadId: "thr_A",
      labelIds: ["INBOX"],
    });
    // Should NOT have fetched message details by default (no body
    // requested, no from-filter set).
    expect(calls.filter((c) => c.toolSlug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID")).toHaveLength(0);
    expect(result.nextState).toEqual({ start_history_id: "hist_200" });
  });

  it("poll: multiple new messages emit one event each, deduped by messageId", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_LIST_HISTORY: [
        historyResp({
          historyId: "hist_300",
          addedMessageIds: [
            { id: "m1", threadId: "t1" },
            { id: "m2", threadId: "t2" },
            { id: "m1", threadId: "t1" }, // duplicate — should be deduped
            { id: "m3", threadId: "t3" },
          ],
        }),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { start_history_id: "hist_200" },
    );
    expect(result.newEvents).toHaveLength(3);
    expect(result.newEvents.map((e) => e.payload.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  it("poll: paginates via nextPageToken until exhausted", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_LIST_HISTORY: [
        historyResp({
          historyId: "hist_p1",
          addedMessageIds: [{ id: "p1m1", threadId: "p1t1" }],
          nextPageToken: "tok_page2",
        }),
        historyResp({
          historyId: "hist_p2",
          addedMessageIds: [{ id: "p2m1", threadId: "p2t1" }],
        }),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { start_history_id: "hist_pre" },
    );
    expect(result.newEvents.map((e) => e.payload.messageId)).toEqual(["p1m1", "p2m1"]);
    const historyCalls = calls.filter((c) => c.toolSlug === "GMAIL_LIST_HISTORY");
    expect(historyCalls).toHaveLength(2);
    expect((historyCalls[1]!.body.arguments as { page_token?: string }).page_token).toBe("tok_page2");
    expect(result.nextState).toEqual({ start_history_id: "hist_p2" });
  });

  it("poll: history-id-too-old (HTTP 404) → falls back to LIST_THREADS + re-baselines", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_LIST_HISTORY: [{ httpStatus: 404, body: "Requested entity was not found." }],
      GMAIL_LIST_THREADS: [
        {
          data: {
            response_data: {
              threads: [
                { id: "thr_x", snippet: "Hi" },
                { id: "thr_y", snippet: "Hello" },
              ],
            },
          },
        },
      ],
      GMAIL_FETCH_USER_PROFILE: [profileResp("hist_FRESH")],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { start_history_id: "hist_ancient" },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(result.newEvents.map((e) => e.payload.messageId)).toEqual(["thr_x", "thr_y"]);
    expect(result.nextState).toEqual({ start_history_id: "hist_FRESH" });
    expect(calls.map((c) => c.toolSlug)).toEqual([
      "GMAIL_LIST_HISTORY",
      "GMAIL_LIST_THREADS",
      "GMAIL_FETCH_USER_PROFILE",
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("poll: include_body=true fetches message details and decodes base64url body", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_LIST_HISTORY: [
        historyResp({
          historyId: "hist_b1",
          addedMessageIds: [{ id: "msgB", threadId: "thrB" }],
        }),
      ],
      GMAIL_FETCH_MESSAGE_BY_THREAD_ID: [
        messageResp({
          id: "msgB",
          threadId: "thrB",
          from: "Alice <alice@example.com>",
          to: "op@example.com",
          subject: "Hello body",
          snippet: "Hello body…",
          bodyText: "Plain body content here.",
        }),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: { include_body: true }, fetch: fetchImpl },
      { start_history_id: "hist_pre" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      messageId: "msgB",
      threadId: "thrB",
      from: "Alice <alice@example.com>",
      to: "op@example.com",
      subject: "Hello body",
      snippet: "Hello body…",
      messageText: "Plain body content here.",
    });
    expect(calls.filter((c) => c.toolSlug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID")).toHaveLength(1);
  });

  it("poll: from-filter drops non-matching senders, emits only matches", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_LIST_HISTORY: [
        historyResp({
          historyId: "hist_f1",
          addedMessageIds: [
            { id: "mA", threadId: "tA" },
            { id: "mB", threadId: "tB" },
          ],
        }),
      ],
      GMAIL_FETCH_MESSAGE_BY_THREAD_ID: [
        messageResp({
          id: "mA",
          threadId: "tA",
          from: "Alice <alice@example.com>",
          subject: "S1",
          snippet: "s1",
        }),
        messageResp({
          id: "mB",
          threadId: "tB",
          from: "Bob <bob@elsewhere.org>",
          subject: "S2",
          snippet: "s2",
        }),
      ],
    });
    const result = await gmailAdapter.poll(
      {
        ...baseArgs,
        config: { from: ["alice@example.com"] },
        fetch: fetchImpl,
      },
      { start_history_id: "hist_pre" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      messageId: "mA",
      from: "Alice <alice@example.com>",
    });
  });

  it("poll: stale state with empty start_history_id → silently re-baselines, zero events", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_FETCH_USER_PROFILE: [profileResp("hist_reset")],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {}, // no start_history_id at all
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState).toEqual({ start_history_id: "hist_reset" });
  });

  it("poll: non-history HTTP error propagates as a normal throw (circuit-breaker counts it)", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_LIST_HISTORY: [{ httpStatus: 503, body: "service unavailable" }],
    });
    await expect(
      gmailAdapter.poll(
        { ...baseArgs, config: {}, fetch: fetchImpl },
        { start_history_id: "hist_xyz" },
      ),
    ).rejects.toThrow(/HTTP 503/);
  });
});

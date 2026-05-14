import { describe, expect, it, vi } from "vitest";
import { gmailAdapter } from "./gmail.js";

interface ExecuteResponse {
  data: { response_data?: unknown } | unknown;
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

function fetchEmailsResp(messages: Array<Record<string, unknown>>): ExecuteResponse {
  // Composio's v3.1 execute envelope wraps in data.response_data.
  return {
    data: {
      response_data: { messages, nextPageToken: null, resultSizeEstimate: messages.length },
    },
    successful: true,
    error: null,
  };
}

const baseArgs = {
  composioUserId: "aa9dd140-account",
  connectedAccountId: "ca_gmail_fixture",
  composioApiKey: "test_key",
};

describe("gmail PollAdapter (FETCH_EMAILS based)", () => {
  it("registers under 'gmail' for GMAIL_NEW_GMAIL_MESSAGE", () => {
    expect(gmailAdapter.toolkit).toBe("gmail");
    expect(gmailAdapter.events).toEqual(["GMAIL_NEW_GMAIL_MESSAGE"]);
  });

  it("initialState returns { last_seen_unix } anchored at now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const state = await gmailAdapter.initialState({ ...baseArgs, config: {} });
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(typeof state.last_seen_unix).toBe("number");
    expect(state.last_seen_unix as number).toBeGreaterThanOrEqual(before);
    expect(state.last_seen_unix as number).toBeLessThanOrEqual(after);
    expect(state.last_seen_message_ids).toEqual([]);
  });

  it("poll: no messages returned → zero events, advances last_seen_unix to now", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_FETCH_EMAILS: [fetchEmailsResp([])],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    expect(result.newEvents).toEqual([]);
    expect((result.nextState.last_seen_unix as number)).toBeGreaterThan(1715000000);
    expect(calls[0]!.toolSlug).toBe("GMAIL_FETCH_EMAILS");
    expect((calls[0]!.args.query as string)).toContain("after:");
  });

  it("poll: single new message emits Composio-shaped payload", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_FETCH_EMAILS: [
        fetchEmailsResp([
          {
            messageId: "msg_A",
            threadId: "thr_A",
            sender: "Alice <alice@example.com>",
            to: "op@example.com",
            subject: "Hello",
            labelIds: ["INBOX", "UNREAD"],
            messageTimestamp: "1715000123",
            preview: { body: "Hello there..." },
          },
        ]),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      messageId: "msg_A",
      threadId: "thr_A",
      from: "Alice <alice@example.com>",
      to: "op@example.com",
      subject: "Hello",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hello there...",
    });
    expect(result.nextState.last_seen_message_ids).toEqual(["msg_A"]);
  });

  it("poll: messages whose id is in last_seen_message_ids are deduped", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_FETCH_EMAILS: [
        fetchEmailsResp([
          { messageId: "already_seen", threadId: "thrX", subject: "old", sender: "a@b.c" },
          { messageId: "actually_new", threadId: "thrY", subject: "new", sender: "x@y.z" },
        ]),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {
        last_seen_unix: 1715000000,
        last_seen_message_ids: ["already_seen"],
      },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload.messageId).toBe("actually_new");
    // The next-state ring captures BOTH ids (so the next poll keeps
    // deduping the boundary message).
    expect(new Set(result.nextState.last_seen_message_ids as string[])).toEqual(
      new Set(["already_seen", "actually_new"]),
    );
  });

  it("poll: from-filter is built into the Gmail query", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_FETCH_EMAILS: [fetchEmailsResp([])],
    });
    await gmailAdapter.poll(
      { ...baseArgs, config: { from: ["@firstround.com", "alice@example.com"] }, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    const query = calls[0]!.args.query as string;
    expect(query).toContain("(from:@firstround.com OR from:alice@example.com)");
  });

  it("poll: label filter is built into the Gmail query", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_FETCH_EMAILS: [fetchEmailsResp([])],
    });
    await gmailAdapter.poll(
      { ...baseArgs, config: { label: "IMPORTANT" }, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    expect((calls[0]!.args.query as string)).toContain("label:IMPORTANT");
  });

  it("poll: include_body=true sets verbose=true on the tool call + emits messageText", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_FETCH_EMAILS: [
        fetchEmailsResp([
          {
            messageId: "msgB",
            threadId: "thrB",
            sender: "a@b.c",
            subject: "S",
            messageText: "Full body content",
            messageTimestamp: "1715000200",
          },
        ]),
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: { include_body: true }, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    expect((calls[0]!.args).verbose).toBe(true);
    expect(result.newEvents[0]!.payload.messageText).toBe("Full body content");
  });

  it("poll: applies SLACK_SECS so after:N is lastSeen-300", async () => {
    const { fetchImpl, calls } = makeFetch({
      GMAIL_FETCH_EMAILS: [fetchEmailsResp([])],
    });
    await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    expect((calls[0]!.args.query as string)).toContain(`after:${1715000000 - 300}`);
  });

  it("poll: missing last_seen_unix → silent re-baseline, zero events, NO fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not fetch on missing-state recovery");
    }) as unknown as typeof fetch;
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {},
    );
    expect(result.newEvents).toEqual([]);
    expect(typeof result.nextState.last_seen_unix).toBe("number");
    expect(result.nextState.last_seen_message_ids).toEqual([]);
  });

  it("poll: HTTP error propagates as a thrown error (cron-kicker circuit breaker counts it)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      gmailAdapter.poll(
        { ...baseArgs, config: {}, fetch: fetchImpl },
        { last_seen_unix: 1715000000 },
      ),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("poll: response shape with messages directly under data (no response_data wrap) also works", async () => {
    const { fetchImpl } = makeFetch({
      GMAIL_FETCH_EMAILS: [
        {
          data: {
            messages: [{ messageId: "msgX", threadId: "thrX", subject: "S", sender: "a@b.c" }],
            nextPageToken: null,
          },
          successful: true,
        } as ExecuteResponse,
      ],
    });
    const result = await gmailAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_unix: 1715000000 },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload.messageId).toBe("msgX");
  });
});

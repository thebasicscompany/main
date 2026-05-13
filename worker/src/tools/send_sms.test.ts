import { afterEach, describe, expect, it, vi } from "vitest";
import {
  send_sms,
  setSendSmsDeps,
  QuotaExceededError,
  SEND_SMS_QUOTA_CAP,
  defaultSendSmsSummarizer,
} from "./send_sms.js";
import { InMemoryQuotaStore } from "../quota-store.js";

const TO = "+15551234567";

function makeCtx(workspaceId = "ws_test") {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    ctx: {
      runId: "run_test",
      workspaceId,
      accountId: "acct_test",
      workspaceRoot: "/tmp",
      session: {} as never,
      publish: async (e: { type: string; payload: Record<string, unknown> }) => {
        events.push(e);
      },
    },
  };
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  setSendSmsDeps(null);
});

describe("send_sms — happy paths", () => {
  it("sends an iMessage and emits output_dispatched (single send, no summary)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    setSendSmsDeps({
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResp({
          messageHandle: "msg_imessage_1",
          sendStyle: "iMessage",
          wasDowngraded: false,
          status: "QUEUED",
        });
      }) as never,
      apiKey: "key_x",
      apiSecret: "secret_y",
      quotaStore: new InMemoryQuotaStore(),
    });

    const { events, ctx } = makeCtx();
    const result = await send_sms.execute(
      { to: TO, body: "short hello" },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.sendblue.co/api/send-message");
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["sb-api-key-id"]).toBe("key_x");
    expect(headers["sb-api-secret-key"]).toBe("secret_y");
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody).toEqual({ number: TO, content: "short hello" });

    const json = (result as { kind: "json"; json: Record<string, unknown> })
      .json;
    expect(json.messageHandle).toBe("msg_imessage_1");
    expect(json.sendStyle).toBe("iMessage");
    expect(json.wasDowngraded).toBe(false);
    expect(json.summaryHandle).toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output_dispatched");
    expect(events[0]!.payload).toMatchObject({
      kind: "output_dispatched",
      channel: "sms",
      recipient_or_key: TO,
      attempt: 1,
    });
  });

  it("includes media_url when provided", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    setSendSmsDeps({
      fetch: (async (_url: string, init?: RequestInit) => {
        calls.push({ init });
        return jsonResp({ messageHandle: "m", sendStyle: "iMessage" });
      }) as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
    });

    const { ctx } = makeCtx();
    await send_sms.execute(
      { to: TO, body: "see pic", mediaUrl: "https://example.com/x.jpg" },
      ctx,
    );
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody).toEqual({
      number: TO,
      content: "see pic",
      media_url: "https://example.com/x.jpg",
    });
  });
});

describe("send_sms — SMS fallback summarizer", () => {
  it("sends a summary second message when long body downgrades to SMS", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => {
        const callIdx = fetchSpy.mock.calls.length;
        if (callIdx === 1) {
          return jsonResp({
            messageHandle: "msg_primary",
            sendStyle: "SMS",
            wasDowngraded: true,
            status: "QUEUED",
          });
        }
        return jsonResp({
          messageHandle: "msg_summary",
          sendStyle: "SMS",
          wasDowngraded: true,
          status: "QUEUED",
        });
      },
    );
    const summarizer = vi.fn(async (b: string) => `summarized: ${b.slice(0, 50)}`);
    setSendSmsDeps({
      fetch: fetchSpy as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
      summarizer,
    });

    const longBody = "x".repeat(500);
    const { events, ctx } = makeCtx();
    const result = await send_sms.execute({ to: TO, body: longBody }, ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(summarizer).toHaveBeenCalledWith(longBody);
    const json = (result as { kind: "json"; json: Record<string, unknown> })
      .json;
    expect(json.messageHandle).toBe("msg_primary");
    expect(json.summaryHandle).toBe("msg_summary");
    expect(json.summaryContent).toContain("summarized:");
    expect(events.map((e) => e.type)).toEqual(["output_dispatched"]);
  });

  it("skips the summary when SMS downgrade fires but body is short", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResp({
        messageHandle: "m",
        sendStyle: "SMS",
        wasDowngraded: true,
        status: "QUEUED",
      }),
    );
    setSendSmsDeps({
      fetch: fetchSpy as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await send_sms.execute({ to: TO, body: "short fallback" }, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the summary when iMessage delivers a long body (no downgrade)", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResp({
        messageHandle: "m",
        sendStyle: "iMessage",
        wasDowngraded: false,
      }),
    );
    setSendSmsDeps({
      fetch: fetchSpy as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await send_sms.execute({ to: TO, body: "x".repeat(500) }, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("survives summary-send failure: primary still succeeds, output_failed emitted alongside output_dispatched", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => {
        const callIdx = fetchSpy.mock.calls.length;
        if (callIdx === 1) {
          return jsonResp({
            messageHandle: "primary",
            sendStyle: "SMS",
            wasDowngraded: true,
          });
        }
        return jsonResp(
          { errorCode: "boom", errorMessage: "summary blew up" },
          500,
        );
      },
    );
    setSendSmsDeps({
      fetch: fetchSpy as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { events, ctx } = makeCtx();
    const result = await send_sms.execute(
      { to: TO, body: "x".repeat(500) },
      ctx,
    );
    const json = (result as { kind: "json"; json: Record<string, unknown> })
      .json;
    expect(json.messageHandle).toBe("primary");
    expect(json.summaryHandle).toBeUndefined();
    expect(events.map((e) => e.type).sort()).toEqual([
      "output_dispatched",
      "output_failed",
    ]);
  });
});

describe("send_sms — quota", () => {
  it("throws QuotaExceededError when increment returns false; fetch never called", async () => {
    const fetchSpy = vi.fn();
    const quotaSpy = vi.fn().mockResolvedValue(false);
    setSendSmsDeps({
      fetch: fetchSpy as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: { increment: quotaSpy },
    });
    const { events, ctx } = makeCtx("ws_capped");
    await expect(
      send_sms.execute({ to: TO, body: "x" }, ctx),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(quotaSpy).toHaveBeenCalledWith("ws_capped", "sms", SEND_SMS_QUOTA_CAP);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("send_sms — error handling", () => {
  it("emits output_failed and rethrows on a non-2xx Sendblue response", async () => {
    setSendSmsDeps({
      fetch: (async () =>
        jsonResp(
          { errorCode: "INVALID_NUMBER", errorMessage: "bad phone" },
          422,
        )) as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { events, ctx } = makeCtx();
    await expect(
      send_sms.execute({ to: TO, body: "hi" }, ctx),
    ).rejects.toThrow(/sendblue_http_422/);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output_failed");
    expect(events[0]!.payload).toMatchObject({
      kind: "output_failed",
      channel: "sms",
      retriable: true,
    });
    expect((events[0]!.payload as { error: { code: string } }).error.code).toBe(
      "INVALID_NUMBER",
    );
  });

  it("rejects an obviously-bad phone number at Zod parse", async () => {
    const fetchSpy = vi.fn();
    setSendSmsDeps({
      fetch: fetchSpy as never,
      apiKey: "k",
      apiSecret: "s",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    for (const bad of ["5551234567", "+1", "+1-555-123-4567"]) {
      await expect(
        send_sms.execute({ to: bad, body: "x" }, ctx),
      ).rejects.toThrow();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("defaultSendSmsSummarizer", () => {
  it("returns the body unchanged when under the 140 limit", async () => {
    expect(await defaultSendSmsSummarizer("short")).toBe("short");
  });

  it("truncates with an ellipsis when over 140 chars", async () => {
    const out = await defaultSendSmsSummarizer("a".repeat(500));
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });
});

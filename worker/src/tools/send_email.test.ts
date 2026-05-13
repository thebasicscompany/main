import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GetObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  send_email,
  setSendEmailDeps,
  QuotaExceededError,
  ATTACHMENT_INLINE_LIMIT_BYTES,
} from "./send_email.js";
import { InMemoryQuotaStore } from "../quota-store.js";

const FROM = "notifications@trybasics.ai";
const BUCKET = "basics-runtime-artifacts-test";

interface CapturedSend {
  cmd?: SendEmailCommand;
}

function bodyOf(cmd: SendEmailCommand | undefined) {
  return cmd?.input;
}

function makeS3WithObject(
  bytes: Buffer,
  contentType: string,
): {
  send: (cmd: GetObjectCommand) => Promise<GetObjectCommandOutput>;
  config: never;
} {
  return {
    send: async () =>
      ({
        $metadata: {},
        Body: {
          transformToByteArray: async () => new Uint8Array(bytes),
        } as never,
        ContentType: contentType,
      }) as unknown as GetObjectCommandOutput,
    config: {} as never,
  };
}

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

function clock(start: number, step: number): () => number {
  let t = start;
  return () => (t += step);
}

afterEach(() => {
  setSendEmailDeps(null);
});

describe("send_email — happy path (no attachments)", () => {
  it("sends Simple Content text email and emits output_dispatched", async () => {
    const captured: CapturedSend = {};
    const quota = new InMemoryQuotaStore();
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          captured.cmd = cmd;
          return { MessageId: "mid_abc123" };
        },
      },
      s3: {} as never,
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: quota,
      now: clock(1_000_000, 7),
    });

    const { events, ctx } = makeCtx();
    const result = await send_email.execute(
      { to: "alice@example.com", subject: "hi", body: "plain text body" },
      ctx,
    );

    expect(result.kind).toBe("json");
    const json = (result as { kind: "json"; json: Record<string, unknown> })
      .json;
    expect(json.messageId).toBe("mid_abc123");
    expect(json.bodyType).toBe("text");
    expect(json.attachmentsAttached).toBe(0);

    const input = bodyOf(captured.cmd)!;
    expect(input.FromEmailAddress).toBe(FROM);
    expect(input.Destination?.ToAddresses).toEqual(["alice@example.com"]);
    expect(input.ConfigurationSetName).toBe("basics-runtime-outbound");
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe("plain text body");
    expect(input.Content?.Simple?.Body?.Html).toBeUndefined();

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("output_dispatched");
    expect(evt.payload).toMatchObject({
      kind: "output_dispatched",
      channel: "email",
      recipient_or_key: "alice@example.com",
      attempt: 1,
    });
  });

  it("autodetects HTML body when first 200 chars contain <", async () => {
    const captured: CapturedSend = {};
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          captured.cmd = cmd;
          return { MessageId: "mid_html" };
        },
      },
      s3: {} as never,
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await send_email.execute(
      {
        to: ["a@x.com", "b@y.com"],
        subject: "html",
        body: "<p>hello world</p>",
      },
      ctx,
    );
    const input = bodyOf(captured.cmd)!;
    expect(input.Content?.Simple?.Body?.Html?.Data).toBe("<p>hello world</p>");
    expect(input.Content?.Simple?.Body?.Text).toBeUndefined();
    expect(input.Destination?.ToAddresses).toEqual(["a@x.com", "b@y.com"]);
  });

  it("honours explicit bodyType override even when content looks like HTML", async () => {
    const captured: CapturedSend = {};
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          captured.cmd = cmd;
          return { MessageId: "mid_txt" };
        },
      },
      s3: {} as never,
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await send_email.execute(
      {
        to: "a@b.com",
        subject: "s",
        body: "<looks like html but treat as text>",
        bodyType: "text",
      },
      ctx,
    );
    const input = bodyOf(captured.cmd)!;
    expect(input.Content?.Simple?.Body?.Text?.Data).toContain(
      "looks like html",
    );
  });
});

describe("send_email — attachments", () => {
  it("MIME-attaches a small (≤100 KB) S3 object via Raw content", async () => {
    const small = Buffer.from("hello, world\n", "utf8");
    const captured: CapturedSend = {};
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          captured.cmd = cmd;
          return { MessageId: "mid_raw" };
        },
      },
      s3: makeS3WithObject(small, "text/plain"),
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
      signedUrlFactory: async () => "https://signed.example/should-not-be-used",
    });

    const { ctx } = makeCtx();
    const result = await send_email.execute(
      {
        to: "a@b.com",
        subject: "with attach",
        body: "see attached",
        attachments: [{ s3Key: "workspaces/ws/runs/r/note.txt" }],
      },
      ctx,
    );

    const input = bodyOf(captured.cmd)!;
    expect(input.Content?.Raw?.Data).toBeDefined();
    const raw = Buffer.from(input.Content!.Raw!.Data!).toString("utf8");
    expect(raw).toContain("From: notifications@trybasics.ai");
    expect(raw).toContain("To: a@b.com");
    expect(raw).toContain("Subject: with attach");
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain(
      'Content-Disposition: attachment; filename="note.txt"',
    );
    // Base64-encoded body bytes should appear inside the raw MIME.
    expect(raw).toContain(small.toString("base64"));

    const json = (result as { kind: "json"; json: Record<string, unknown> })
      .json;
    expect(json.attachmentsAttached).toBe(1);
    expect(json.attachmentsLinked).toEqual([]);
  });

  it("replaces an oversized (>100 KB) attachment with a signed-URL link in body", async () => {
    const oversized = Buffer.alloc(ATTACHMENT_INLINE_LIMIT_BYTES + 1, 0x41);
    const captured: CapturedSend = {};
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          captured.cmd = cmd;
          return { MessageId: "mid_link" };
        },
      },
      s3: makeS3WithObject(oversized, "application/pdf"),
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
      signedUrlFactory: async () => "https://signed.example/big.pdf",
    });

    const { ctx } = makeCtx();
    const result = await send_email.execute(
      {
        to: "a@b.com",
        subject: "big",
        body: "see link",
        attachments: [
          { s3Key: "workspaces/ws/runs/r/big.pdf", filename: "big.pdf" },
        ],
      },
      ctx,
    );

    const input = bodyOf(captured.cmd)!;
    // No Raw content — we kept it Simple because nothing was inlined.
    expect(input.Content?.Simple).toBeDefined();
    expect(input.Content?.Raw).toBeUndefined();
    const bodyData = input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(bodyData).toContain("see link");
    expect(bodyData).toContain("https://signed.example/big.pdf");
    expect(bodyData).toContain("big.pdf");

    const json = (result as { kind: "json"; json: Record<string, unknown> })
      .json;
    expect(json.attachmentsAttached).toBe(0);
    expect(json.attachmentsLinked).toHaveLength(1);
  });
});

describe("send_email — quota gate", () => {
  it("refuses to send and throws QuotaExceededError when increment returns false", async () => {
    const sendSpy = vi.fn();
    const quotaSpy = vi.fn().mockResolvedValue(false);
    setSendEmailDeps({
      ses: { send: sendSpy },
      s3: {} as never,
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: { increment: quotaSpy },
    });

    const { events, ctx } = makeCtx("ws_capped");
    await expect(
      send_email.execute({ to: "x@y.com", subject: "s", body: "b" }, ctx),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    expect(quotaSpy).toHaveBeenCalledWith("ws_capped", "email", 200);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("send_email — header injection guards", () => {
  it("rejects a subject containing CRLF", async () => {
    const sendSpy = vi.fn();
    setSendEmailDeps({
      ses: { send: sendSpy },
      s3: {} as never,
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await expect(
      send_email.execute(
        {
          to: "x@y.com",
          subject: "ok\r\nBcc: attacker@evil.com",
          body: "b",
        },
        ctx,
      ),
    ).rejects.toThrow();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects an attachment filename containing CRLF or quotes", async () => {
    const sendSpy = vi.fn();
    setSendEmailDeps({
      ses: { send: sendSpy },
      s3: makeS3WithObject(Buffer.from("hi"), "text/plain"),
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
      signedUrlFactory: async () => "x",
    });
    const { ctx } = makeCtx();
    for (const bad of ["a\r\nBcc: e@x.com", 'evil".pdf', "back\\slash"]) {
      await expect(
        send_email.execute(
          {
            to: "x@y.com",
            subject: "s",
            body: "b",
            attachments: [{ s3Key: "ws/r/x", filename: bad }],
          },
          ctx,
        ),
      ).rejects.toThrow();
    }
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("send_email — SES failure", () => {
  it("emits output_failed and propagates when SES.send rejects", async () => {
    const sesErr = Object.assign(new Error("Throttling"), {
      name: "ThrottlingException",
    });
    setSendEmailDeps({
      ses: {
        send: async () => {
          throw sesErr;
        },
      },
      s3: {} as never,
      bucket: BUCKET,
      fromEmail: FROM,
      quotaStore: new InMemoryQuotaStore(),
    });

    const { events, ctx } = makeCtx();
    await expect(
      send_email.execute({ to: "x@y.com", subject: "s", body: "b" }, ctx),
    ).rejects.toThrow(/Throttling/);

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("output_failed");
    expect(evt.payload).toMatchObject({
      kind: "output_failed",
      channel: "email",
      retriable: true,
      error: { code: "ThrottlingException" },
    });
  });
});

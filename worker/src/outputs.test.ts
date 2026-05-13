import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchOutputs, normalizeRunStatus } from "./outputs.js";
import { setSendEmailDeps } from "./tools/send_email.js";
import { setSendSmsDeps } from "./tools/send_sms.js";
import { InMemoryQuotaStore } from "./quota-store.js";

function makeCtx() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    ctx: {
      runId: "run_test",
      workspaceId: "ws_test",
      accountId: "acct_test",
      workspaceRoot: "/tmp",
      session: {} as never,
      publish: async (e: { type: string; payload: Record<string, unknown> }) => {
        events.push(e);
      },
    },
  };
}

afterEach(() => {
  setSendEmailDeps(null);
  setSendSmsDeps(null);
});

function stubEmailSuccess() {
  setSendEmailDeps({
    ses: { send: async () => ({ MessageId: "mid_email_stub" }) },
    s3: {} as never,
    bucket: "b",
    fromEmail: "from@x.com",
    quotaStore: new InMemoryQuotaStore(),
  });
}

function stubSmsSuccess() {
  setSendSmsDeps({
    fetch: (async () =>
      new Response(
        JSON.stringify({
          message_handle: "mid_sms_stub",
          send_style: "iMessage",
          was_downgraded: false,
          status: "QUEUED",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as never,
    apiKey: "k",
    apiSecret: "s",
    fromNumber: "+13472760577",
    quotaStore: new InMemoryQuotaStore(),
  });
}

describe("dispatchOutputs — when filter (plan A.8 verify a/b)", () => {
  it("on_complete skips when run failed (a)", async () => {
    stubEmailSuccess();
    stubSmsSuccess();
    const { events, ctx } = makeCtx();
    const result = await dispatchOutputs(
      ctx,
      {
        id: "auto_1",
        outputs: [
          { channel: "email", to: "x@y.com", when: "on_complete" },
          { channel: "sms", to: "+15551112222", when: "on_complete" },
        ],
      },
      { status: "failed", summary: "boom" },
    );
    expect(result.skipped).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.perChannel.every((p) => p.status === "skipped")).toBe(true);
    // Summary still fires.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output_dispatch_summary");
    expect(events[0]!.payload).toMatchObject({
      automation_id: "auto_1",
      run_status: "failed",
      total: 2,
      skipped: 2,
    });
  });

  it("on_failure skips when run completed (b)", async () => {
    stubEmailSuccess();
    const { ctx } = makeCtx();
    const result = await dispatchOutputs(
      ctx,
      {
        id: "auto_2",
        outputs: [{ channel: "email", to: "x@y.com", when: "on_failure" }],
      },
      { status: "completed", summary: "all good" },
    );
    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("'always' fires regardless of status", async () => {
    stubEmailSuccess();
    const { ctx } = makeCtx();
    const okResult = await dispatchOutputs(
      ctx,
      {
        id: "auto_3",
        outputs: [{ channel: "email", to: "x@y.com", when: "always" }],
      },
      { status: "completed", summary: "yay" },
    );
    expect(okResult.succeeded).toBe(1);

    stubEmailSuccess();
    const { ctx: ctx2 } = makeCtx();
    const failResult = await dispatchOutputs(
      ctx2,
      {
        id: "auto_3",
        outputs: [{ channel: "email", to: "x@y.com", when: "always" }],
      },
      { status: "failed", summary: "nope" },
    );
    expect(failResult.succeeded).toBe(1);
  });
});

describe("dispatchOutputs — partial failure isolation (plan A.8 verify c)", () => {
  it("one channel failing doesn't block the others (c)", async () => {
    // Email succeeds; SMS fails.
    setSendEmailDeps({
      ses: { send: async () => ({ MessageId: "mid_ok" }) },
      s3: {} as never,
      bucket: "b",
      fromEmail: "from@x.com",
      quotaStore: new InMemoryQuotaStore(),
    });
    setSendSmsDeps({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            error_code: "INVALID_NUMBER",
            error_message: "bad phone",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        )) as never,
      apiKey: "k",
      apiSecret: "s",
      fromNumber: "+13472760577",
      quotaStore: new InMemoryQuotaStore(),
    });

    const { events, ctx } = makeCtx();
    const result = await dispatchOutputs(
      ctx,
      {
        id: "auto_partial",
        outputs: [
          { channel: "email", to: "ok@x.com", when: "on_complete" },
          { channel: "sms", to: "+15551112222", when: "on_complete" },
        ],
      },
      { status: "completed", summary: "summary text" },
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.perChannel.find((p) => p.channel === "email")?.status).toBe(
      "ok",
    );
    const smsResult = result.perChannel.find((p) => p.channel === "sms");
    expect(smsResult?.status).toBe("error");
    expect(smsResult?.error?.code).toBe("INVALID_NUMBER");

    // The dispatch summary captures both.
    const summary = events.find((e) => e.type === "output_dispatch_summary");
    expect(summary?.payload).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });
  });
});

describe("dispatchOutputs — output_dispatch_summary shape (plan A.8 verify d)", () => {
  it("summary event includes per-channel results with correct statuses (d)", async () => {
    stubEmailSuccess();
    stubSmsSuccess();
    const { events, ctx } = makeCtx();
    await dispatchOutputs(
      ctx,
      {
        id: "auto_summary",
        name: "Daily LP digest",
        outputs: [
          { channel: "email", to: "a@x.com", when: "on_complete" },
          { channel: "sms", to: "+15550001111", when: "on_complete" },
          { channel: "email", to: "b@x.com", when: "on_failure" },
        ],
      },
      { status: "completed", summary: "the digest body" },
    );

    const summary = events.find((e) => e.type === "output_dispatch_summary");
    expect(summary).toBeDefined();
    expect(summary!.payload).toMatchObject({
      kind: "output_dispatch_summary",
      automation_id: "auto_summary",
      run_status: "completed",
      total: 3,
      succeeded: 2,
      failed: 0,
      skipped: 1,
    });
    const results = summary!.payload.results as Array<{
      channel: string;
      status: string;
    }>;
    expect(results).toHaveLength(3);
    expect(results.map((r) => `${r.channel}:${r.status}`).sort()).toEqual([
      "email:ok",
      "email:skipped",
      "sms:ok",
    ]);
  });

  it("uses automation.name as default subject when output.subject is absent", async () => {
    let capturedSubject = "";
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          const subj = cmd.input.Content?.Simple?.Subject?.Data;
          if (subj) capturedSubject = subj;
          return { MessageId: "mid" };
        },
      },
      s3: {} as never,
      bucket: "b",
      fromEmail: "from@x.com",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await dispatchOutputs(
      ctx,
      {
        id: "auto_default_subj",
        name: "LP Mapping",
        outputs: [{ channel: "email", to: "x@y.com", when: "on_complete" }],
      },
      { status: "completed", summary: "body" },
    );
    expect(capturedSubject).toBe("Automation done: LP Mapping");
  });

  it("respects explicit output.subject", async () => {
    let capturedSubject = "";
    setSendEmailDeps({
      ses: {
        send: async (cmd) => {
          const subj = cmd.input.Content?.Simple?.Subject?.Data;
          if (subj) capturedSubject = subj;
          return { MessageId: "mid" };
        },
      },
      s3: {} as never,
      bucket: "b",
      fromEmail: "from@x.com",
      quotaStore: new InMemoryQuotaStore(),
    });
    const { ctx } = makeCtx();
    await dispatchOutputs(
      ctx,
      {
        id: "auto_explicit_subj",
        outputs: [
          {
            channel: "email",
            to: "x@y.com",
            subject: "Custom subject line",
            when: "always",
          },
        ],
      },
      { status: "completed", summary: "b" },
    );
    expect(capturedSubject).toBe("Custom subject line");
  });
});

describe("dispatchOutputs — artifact channel + includeArtifacts", () => {
  it("artifact channel entries are skipped (mid-run only, not a dispatch channel)", async () => {
    const { ctx } = makeCtx();
    const result = await dispatchOutputs(
      ctx,
      {
        id: "auto_art",
        outputs: [{ channel: "artifact", to: "ignored", when: "always" }],
      },
      { status: "completed" },
    );
    expect(result.perChannel[0]!.status).toBe("skipped");
  });

  it("includeArtifacts:true threads runResult.artifacts into the send_email attachments param", async () => {
    let capturedInput: unknown = null;
    setSendEmailDeps({
      ses: {
        send: async () => ({ MessageId: "mid" }),
      },
      s3: {
        send: async () =>
          ({
            $metadata: {},
            Body: {
              transformToByteArray: async () => new Uint8Array([1, 2, 3]),
            } as never,
            ContentType: "image/png",
          }) as never,
        config: {} as never,
      },
      bucket: "b",
      fromEmail: "from@x.com",
      quotaStore: new InMemoryQuotaStore(),
      signedUrlFactory: async () => "https://signed.example/x",
    });
    const sendEmailModule = await import("./tools/send_email.js");
    const orig = sendEmailModule.send_email.execute;
    (sendEmailModule.send_email as { execute: typeof orig }).execute =
      async (input: unknown, ctx2: unknown) => {
        capturedInput = input;
        return orig(input as never, ctx2 as never);
      };
    try {
      const { ctx } = makeCtx();
      await dispatchOutputs(
        ctx,
        {
          id: "auto_art2",
          outputs: [
            {
              channel: "email",
              to: "x@y.com",
              includeArtifacts: true,
              when: "always",
            },
          ],
        },
        {
          status: "completed",
          summary: "see attached",
          artifacts: [{ s3Key: "ws/r/page.png", filename: "page.png" }],
        },
      );
      expect((capturedInput as { attachments: unknown[] }).attachments)
        .toEqual([{ s3Key: "ws/r/page.png", filename: "page.png" }]);
    } finally {
      (sendEmailModule.send_email as { execute: typeof orig }).execute = orig;
    }
  });
});

describe("normalizeRunStatus", () => {
  it("maps success/completed to completed; everything else to failed", () => {
    expect(normalizeRunStatus("success")).toBe("completed");
    expect(normalizeRunStatus("completed")).toBe("completed");
    expect(normalizeRunStatus("error")).toBe("failed");
    expect(normalizeRunStatus("failed")).toBe("failed");
    expect(normalizeRunStatus("anything-else")).toBe("failed");
  });
});

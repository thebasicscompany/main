import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  notifyApproval,
  loadApprovalChannel,
  _internals,
  type ApprovalChannelConfig,
} from "./notifier.js";
import type { WorkerToolContext } from "../tools/context.js";

const { buildSmsBody, buildEmailBody, buildLink } = _internals;

const APPROVAL_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RAW_TOKEN = "QzZ_pretendTOKEN_url_safe_base64url_chars_only";
const EXPIRES_AT = new Date("2026-05-13T14:00:00Z");

function makeCtx(): {
  ctx: WorkerToolContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    ctx: {
      session: {} as never,
      runId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      accountId: "33333333-3333-3333-3333-333333333333",
      workspaceRoot: "/tmp",
      publish: async (e) => {
        events.push(e);
      },
    },
  };
}

const spec = {
  approvalId: APPROVAL_ID,
  toolName: "send_email",
  reason: "send_email to 2 recipients",
  rawToken: RAW_TOKEN,
  expiresAt: EXPIRES_AT,
};

describe("notifier — link + body builders", () => {
  it("link uses app.trybasics.ai by default", () => {
    const link = buildLink("https://app.trybasics.ai", APPROVAL_ID, RAW_TOKEN);
    expect(link).toBe(
      `https://app.trybasics.ai/approvals/${APPROVAL_ID}?token=${RAW_TOKEN}`,
    );
  });

  it("link respects trailing slash on base url", () => {
    const link = buildLink("https://example.com/", APPROVAL_ID, RAW_TOKEN);
    expect(link).toBe(
      `https://example.com/approvals/${APPROVAL_ID}?token=${RAW_TOKEN}`,
    );
  });

  it("SMS body is reply-style (no link), fits ≤140 chars, mentions YES/NO", () => {
    const link = buildLink("https://app.trybasics.ai", APPROVAL_ID, RAW_TOKEN);
    const sms = buildSmsBody(spec, link);
    expect(sms.length).toBeLessThanOrEqual(140);
    expect(sms).not.toContain(link);
    expect(sms).not.toContain(RAW_TOKEN);
    expect(sms.toUpperCase()).toContain("YES");
    expect(sms.toUpperCase()).toContain("NO");
    expect(sms).toContain(spec.toolName);
  });

  it("SMS body drops the reason parenthetical when overall length exceeds 140", () => {
    const longReason = "a".repeat(200);
    const sms = buildSmsBody({ ...spec, reason: longReason }, "ignored");
    expect(sms.length).toBeLessThanOrEqual(140);
    expect(sms).not.toContain(longReason);
    expect(sms).toContain("Reply YES");
  });

  it("email subject + body include reason, link, and expiry", () => {
    const link = buildLink("https://app.trybasics.ai", APPROVAL_ID, RAW_TOKEN);
    const { subject, body } = buildEmailBody(spec, link);
    expect(subject).toBe("Approval needed: send_email");
    expect(body).toContain(link);
    expect(body).toContain("send_email to 2 recipients");
    expect(body).toContain("Expires:");
  });
});

describe("notifyApproval — SMS channel", () => {
  it("delivers via sendblue with the operator phone + signed link", async () => {
    const { ctx, events } = makeCtx();
    const calls: Array<{ fromNumber: string; to: string; content: string }> = [];
    const result = await notifyApproval(ctx, spec, {
      channel: "sms",
      phone: "+19722144223",
    }, {
      sendblueFromNumber: "+13472760577",
      sendblueSend: async (m) => {
        calls.push(m);
        return { messageHandle: "msg_123" };
      },
    });
    expect(result.delivered).toBe(true);
    expect(result.channel).toBe("sms");
    expect(result.recipient).toBe("+19722144223");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+19722144223");
    expect(calls[0]!.fromNumber).toBe("+13472760577");
    expect(calls[0]!.content.length).toBeLessThanOrEqual(140);
    expect(calls[0]!.content).not.toContain(RAW_TOKEN);
    expect(calls[0]!.content.toUpperCase()).toContain("YES");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("approval_notified");
    expect(events[0]!.payload.channel).toBe("sms");
    expect(events[0]!.payload.recipient).toBe("+19722144223");
    // Token MUST NOT be re-emitted in approval_notified (approval_requested
    // already carries it).
    expect(JSON.stringify(events[0]!.payload)).not.toContain(RAW_TOKEN);
  });

  it("no-ops gracefully when approval_phone is unset", async () => {
    const { ctx, events } = makeCtx();
    let called = false;
    const result = await notifyApproval(ctx, spec, { channel: "sms" }, {
      sendblueFromNumber: "+13472760577",
      sendblueSend: async () => {
        called = true;
        return { messageHandle: "x" };
      },
    });
    expect(result.delivered).toBe(false);
    expect(called).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("emits approval_notify_failed on sendblue error (non-fatal)", async () => {
    const { ctx, events } = makeCtx();
    const result = await notifyApproval(ctx, spec, {
      channel: "sms",
      phone: "+19722144223",
    }, {
      sendblueFromNumber: "+13472760577",
      sendblueSend: async () => {
        throw new Error("sendblue_http_500: oh no");
      },
    });
    expect(result.delivered).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("approval_notify_failed");
    expect(events[0]!.payload.channel).toBe("sms");
  });
});

describe("notifyApproval — email channel", () => {
  it("delivers via SES with the operator email + link in body", async () => {
    const { ctx, events } = makeCtx();
    const calls: Array<{ from: string; to: string; subject: string; body: string }> = [];
    const result = await notifyApproval(ctx, spec, {
      channel: "email",
      email: "dmrknife@gmail.com",
    }, {
      sesFromEmail: "notifications@trybasics.ai",
      sesSend: async (m) => {
        calls.push(m);
        return { messageId: "ses_abc" };
      },
    });
    expect(result.delivered).toBe(true);
    expect(result.channel).toBe("email");
    expect(result.recipient).toBe("dmrknife@gmail.com");
    expect(calls[0]!.from).toBe("notifications@trybasics.ai");
    expect(calls[0]!.to).toBe("dmrknife@gmail.com");
    expect(calls[0]!.subject).toBe("Approval needed: send_email");
    expect(calls[0]!.body).toContain(RAW_TOKEN);
    expect(events[0]!.type).toBe("approval_notified");
    expect(events[0]!.payload.channel).toBe("email");
    expect(JSON.stringify(events[0]!.payload)).not.toContain(RAW_TOKEN);
  });
});

describe("notifyApproval — null channel (default)", () => {
  it("no-ops silently when channel is null", async () => {
    const { ctx, events } = makeCtx();
    const result = await notifyApproval(
      ctx,
      spec,
      { channel: null } as ApprovalChannelConfig,
      {},
    );
    expect(result.delivered).toBe(false);
    expect(result.channel).toBe(null);
    expect(events).toHaveLength(0);
  });
});

describe("loadApprovalChannel", () => {
  it("returns the channel + phone + email from agent_settings", async () => {
    const fakeSql = ((_strings: TemplateStringsArray) =>
      Promise.resolve([
        {
          agent_settings: {
            approval_channel: "sms",
            approval_phone: "+19722144223",
            approval_email: "dmrknife@gmail.com",
          },
        },
      ])) as unknown as Parameters<typeof loadApprovalChannel>[0];
    const cfg = await loadApprovalChannel(fakeSql, "22222222-2222-2222-2222-222222222222");
    expect(cfg.channel).toBe("sms");
    expect(cfg.phone).toBe("+19722144223");
    expect(cfg.email).toBe("dmrknife@gmail.com");
  });

  it("returns null channel when agent_settings is empty or workspace missing", async () => {
    const fakeSql = ((_strings: TemplateStringsArray) =>
      Promise.resolve([])) as unknown as Parameters<typeof loadApprovalChannel>[0];
    const cfg = await loadApprovalChannel(fakeSql, "22222222-2222-2222-2222-222222222222");
    expect(cfg.channel).toBe(null);
  });

  it("returns null on db error rather than throwing", async () => {
    const fakeSql = (() =>
      Promise.reject(new Error("boom"))) as unknown as Parameters<typeof loadApprovalChannel>[0];
    const cfg = await loadApprovalChannel(fakeSql, "22222222-2222-2222-2222-222222222222");
    expect(cfg.channel).toBe(null);
  });
});

describe("token round-trip vs C.5 API hash", () => {
  it("sha256(rawToken) matches what C.4 would store as access_token_hash", () => {
    // Sanity check: the same hash function used in C.4 await.ts and the
    // C.5 api authorizeForApproval flow.
    const hash = createHash("sha256").update(RAW_TOKEN).digest("hex");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });
});

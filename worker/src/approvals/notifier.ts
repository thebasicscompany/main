// C.6 — Notification path for unattended approvals.
//
// After awaitApproval emits `approval_requested`, this module looks up
// the workspace's preferred approval channel (sms/email/null) and
// fires a notification containing a signed link the operator can click
// to decide the approval. The signed link's `?token=<raw>` is the same
// raw access token C.4 minted into `approvals.access_token_hash`; the
// C.5 API endpoint sha256s the token and compares it to that hash, so
// no extra signing infrastructure is needed.
//
// Why this is NOT a worker tool call:
//   - send_sms / send_email both have `approval` inspectors (C.3); calling
//     them from inside the approval gate would recurse.
//   - These are SYSTEM notifications, not user-output, so they shouldn't
//     count against the per-workspace email/sms quotas the tools enforce.
// So we call SES / Sendblue HTTP APIs directly with their own credentials.
//
// Channel discovery (Phase D forward-compat):
//   The plan ultimately reads `automation.approval_channel`. Phase D
//   adds the `automations` table; for now we read the same shape off
//   `workspaces.agent_settings -> 'approval_channel|approval_phone|
//   approval_email'`. `loadApprovalChannel()` is the single hook the
//   D.x step will swap out.
//
// Failures here are intentionally non-fatal — the activity event has
// already broadcast the request to any SSE consumer, so a notifier crash
// shouldn't block the worker's LISTEN loop.

import type postgres from "postgres";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { WorkerToolContext } from "../tools/context.js";

export interface ApprovalChannelConfig {
  channel: "sms" | "email" | null;
  phone?: string;
  email?: string;
}

/** Pluggable hook so Phase D can read `automations.approval_channel`. */
export async function loadApprovalChannel(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
): Promise<ApprovalChannelConfig> {
  try {
    const rows = await sql<
      Array<{ agent_settings: Record<string, unknown> | null }>
    >`
      SELECT agent_settings FROM public.workspaces WHERE id = ${workspaceId} LIMIT 1
    `;
    const cfg = (rows[0]?.agent_settings ?? {}) as Record<string, unknown>;
    const ch = cfg.approval_channel;
    const phone = typeof cfg.approval_phone === "string" ? cfg.approval_phone : undefined;
    const email = typeof cfg.approval_email === "string" ? cfg.approval_email : undefined;
    if (ch === "sms" || ch === "email") {
      const result: ApprovalChannelConfig = { channel: ch };
      if (phone) result.phone = phone;
      if (email) result.email = email;
      return result;
    }
    return { channel: null };
  } catch (e) {
    console.error("notifier: loadApprovalChannel failed", (e as Error).message);
    return { channel: null };
  }
}

export interface NotifyApprovalSpec {
  approvalId: string;
  toolName: string;
  reason: string;
  rawToken: string;
  expiresAt: Date;
}

export interface NotifierDeps {
  /** Test seam: skip the live HTTP calls and just record what would have been sent. */
  sesSend?: (msg: { from: string; to: string; subject: string; body: string }) => Promise<{ messageId: string }>;
  sendblueSend?: (msg: { fromNumber: string; to: string; content: string }) => Promise<{ messageHandle: string }>;
  /** Override the deep-link base; defaults to https://app.trybasics.ai. */
  appBaseUrl?: string;
  /** Override env reads for tests. */
  sendblueApiKey?: string;
  sendblueApiSecret?: string;
  sendblueFromNumber?: string;
  sesFromEmail?: string;
  awsRegion?: string;
  fetch?: typeof globalThis.fetch;
}

const SENDBLUE_API_URL = "https://api.sendblue.co/api/send-message";
const SMS_MAX = 140;

function buildLink(baseUrl: string, approvalId: string, rawToken: string): string {
  // Token goes in the query string. Don't url-encode raw because the
  // worker mints it via `randomBytes(32).toString("base64url")` — that
  // alphabet is url-safe and doesn't need encoding.
  return `${baseUrl.replace(/\/$/, "")}/approvals/${approvalId}?token=${rawToken}`;
}

function buildSmsBody(spec: NotifyApprovalSpec, _link: string): string {
  // Reply-to-approve flow: drop the link entirely. The operator replies
  // YES/NO in the SMS thread; api/src/routes/sendblue-inbound.ts handles
  // the inbound webhook and matches by sender phone (workspace.agent_settings.approval_phone).
  // The `_link` arg is kept in the signature so the email path can reuse
  // buildEmailBody unchanged.
  const reason = spec.reason ? ` (${spec.reason})` : "";
  const body = `Approval needed: ${spec.toolName}${reason}. Reply YES to approve, NO to deny.`;
  if (body.length <= SMS_MAX) return body;
  // Pathological: extremely long tool name + reason. Drop reason first.
  const trimmed = `Approval needed: ${spec.toolName}. Reply YES to approve, NO to deny.`;
  if (trimmed.length <= SMS_MAX) return trimmed;
  // Last resort: hard-truncate but keep the reply instruction.
  const tail = " Reply YES/NO.";
  const head = `Approval needed: ${spec.toolName}`.slice(0, SMS_MAX - tail.length);
  return `${head}${tail}`;
}

function buildEmailBody(spec: NotifyApprovalSpec, link: string): {
  subject: string;
  body: string;
} {
  const subject = `Approval needed: ${spec.toolName}`;
  const body =
    `Your Basics agent needs approval to call ${spec.toolName}.\n` +
    `\n` +
    `Reason: ${spec.reason}\n` +
    `Expires: ${spec.expiresAt.toUTCString()}\n` +
    `\n` +
    `Decide here: ${link}\n` +
    `\n` +
    `This link is single-use and tied to this specific approval.\n`;
  return { subject, body };
}

async function defaultSesSend(
  deps: NotifierDeps,
  msg: { from: string; to: string; subject: string; body: string },
): Promise<{ messageId: string }> {
  const region = deps.awsRegion ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new SESv2Client({ region });
  const out = await client.send(
    new SendEmailCommand({
      FromEmailAddress: msg.from,
      Destination: { ToAddresses: [msg.to] },
      ConfigurationSetName: "basics-runtime-outbound",
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: { Text: { Data: msg.body, Charset: "UTF-8" } },
        },
      },
    }),
  );
  return { messageId: out.MessageId ?? "unknown" };
}

async function defaultSendblueSend(
  deps: NotifierDeps,
  msg: { fromNumber: string; to: string; content: string },
): Promise<{ messageHandle: string }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const apiKey = deps.sendblueApiKey ?? process.env.SENDBLUE_API_KEY;
  const apiSecret = deps.sendblueApiSecret ?? process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("notifier: SENDBLUE_API_KEY / SENDBLUE_API_SECRET unset");
  }
  const res = await fetchImpl(SENDBLUE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "sb-api-key-id": apiKey,
      "sb-api-secret-key": apiSecret,
    },
    body: JSON.stringify({
      number: msg.to,
      from_number: msg.fromNumber,
      content: msg.content,
    }),
  });
  const ok = res.status >= 200 && res.status < 300;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* tolerate empty body */
  }
  const handle = (parsed.message_handle ?? parsed.messageHandle) as
    | string
    | undefined;
  const errMsg = (parsed.error_message ?? parsed.errorMessage) as
    | string
    | undefined;
  if (!ok || (!handle && errMsg)) {
    throw new Error(`sendblue_http_${res.status}: ${errMsg ?? "no body"}`);
  }
  return { messageHandle: handle ?? "unknown" };
}

/**
 * Fire-and-(swallow-error) notification dispatch. Caller passes in the
 * channel config; we never re-fetch here so awaitApproval can do a single
 * sql round-trip.
 */
export async function notifyApproval(
  ctx: WorkerToolContext,
  spec: NotifyApprovalSpec,
  config: ApprovalChannelConfig,
  deps: NotifierDeps = {},
): Promise<{ delivered: boolean; channel: string | null; recipient: string | null }> {
  if (!config.channel) {
    return { delivered: false, channel: null, recipient: null };
  }

  const appBaseUrl = deps.appBaseUrl ?? process.env.APP_BASE_URL ?? "https://app.trybasics.ai";
  const link = buildLink(appBaseUrl, spec.approvalId, spec.rawToken);

  try {
    if (config.channel === "sms") {
      const to = config.phone;
      if (!to) {
        console.error("notifier: approval_channel=sms but no approval_phone configured");
        return { delivered: false, channel: "sms", recipient: null };
      }
      const fromNumber =
        deps.sendblueFromNumber ?? process.env.SENDBLUE_FROM_NUMBER ?? "";
      if (!fromNumber) {
        throw new Error("notifier: SENDBLUE_FROM_NUMBER unset");
      }
      const content = buildSmsBody(spec, link);
      const send = deps.sendblueSend ?? ((m) => defaultSendblueSend(deps, m));
      await send({ fromNumber, to, content });
      await ctx.publish({
        type: "approval_notified",
        payload: {
          kind: "approval_notified",
          approval_id: spec.approvalId,
          tool_name: spec.toolName,
          channel: "sms",
          recipient: to,
          // Deliberately omit the raw token / full link from the event payload —
          // approval_requested already carries the token; replicating it
          // here would just add another row in cloud_activity that exposes it.
        },
      });
      return { delivered: true, channel: "sms", recipient: to };
    }

    // email
    const to = config.email;
    if (!to) {
      console.error("notifier: approval_channel=email but no approval_email configured");
      return { delivered: false, channel: "email", recipient: null };
    }
    const from = deps.sesFromEmail ?? process.env.SES_FROM_EMAIL;
    if (!from) {
      throw new Error("notifier: SES_FROM_EMAIL unset");
    }
    const { subject, body } = buildEmailBody(spec, link);
    const send = deps.sesSend ?? ((m) => defaultSesSend(deps, m));
    await send({ from, to, subject, body });
    await ctx.publish({
      type: "approval_notified",
      payload: {
        kind: "approval_notified",
        approval_id: spec.approvalId,
        tool_name: spec.toolName,
        channel: "email",
        recipient: to,
      },
    });
    return { delivered: true, channel: "email", recipient: to };
  } catch (e) {
    console.error(
      "notifier: send failed (non-fatal)",
      (e as Error).message,
      { approvalId: spec.approvalId, channel: config.channel },
    );
    try {
      await ctx.publish({
        type: "approval_notify_failed",
        payload: {
          kind: "approval_notify_failed",
          approval_id: spec.approvalId,
          channel: config.channel,
          error: (e as Error).message,
        },
      });
    } catch {
      /* best-effort */
    }
    return { delivered: false, channel: config.channel, recipient: null };
  }
}

// Test-only exports.
export const _internals = { buildSmsBody, buildEmailBody, buildLink };

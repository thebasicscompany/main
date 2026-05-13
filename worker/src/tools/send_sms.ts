import { defineTool } from "@basics/shared";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";
import type { QuotaStore } from "../quota-store.js";
import { sendSmsApproval } from "../approvals/policy.js";

export const SEND_SMS_QUOTA_CAP = 50;
const SENDBLUE_API_URL = "https://api.sendblue.co/api/send-message";

// SMS carriers truncate hard at ~160 chars. Anything longer in the
// imessage-fallback path gets summarized into a second short message.
const SMS_LONG_THRESHOLD = 160;
const SMS_SUMMARY_LIMIT = 140;

const ParamsSchema = z.object({
  to: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +15551234567"),
  body: z.string().min(1).max(10_000),
  mediaUrl: z.string().url().optional(),
});

// Sendblue's actual response shape uses snake_case for these fields
// (`message_handle`, `was_downgraded`, `send_style`, `error_message`).
// camelCase variants are accepted too for forward-compat in case Sendblue
// flips conventions on a future API version.
export interface SendblueSendResponse {
  message_handle?: string;
  messageHandle?: string;
  status?: string;
  send_style?: "iMessage" | "SMS" | "" | null;
  sendStyle?: "iMessage" | "SMS" | "" | null;
  was_downgraded?: boolean | null;
  wasDowngraded?: boolean | null;
  error_code?: string | number | null;
  errorCode?: string | number | null;
  error_message?: string | null;
  errorMessage?: string | null;
}

function messageHandleOf(r: SendblueSendResponse): string | undefined {
  return r.message_handle ?? r.messageHandle ?? undefined;
}
function sendStyleOf(r: SendblueSendResponse): "iMessage" | "SMS" | undefined {
  const v = r.send_style ?? r.sendStyle;
  return v === "iMessage" || v === "SMS" ? v : undefined;
}
function wasDowngradedOf(r: SendblueSendResponse): boolean {
  return r.was_downgraded === true || r.wasDowngraded === true;
}
function errorCodeOf(r: SendblueSendResponse): string | undefined {
  const v = r.error_code ?? r.errorCode;
  return v == null ? undefined : String(v);
}
function errorMessageOf(r: SendblueSendResponse): string | undefined {
  return r.error_message ?? r.errorMessage ?? undefined;
}

export type SendSmsSummarizer = (body: string) => Promise<string>;

/** Default summarizer: hard-truncate to SMS_SUMMARY_LIMIT chars with an ellipsis. */
export const defaultSendSmsSummarizer: SendSmsSummarizer = async (body) => {
  if (body.length <= SMS_SUMMARY_LIMIT) return body;
  return `${body.slice(0, SMS_SUMMARY_LIMIT - 1).trim()}…`;
};

export interface SendSmsDeps {
  fetch: typeof globalThis.fetch;
  apiKey: string;
  apiSecret: string;
  /** Sendblue-registered E.164 sender number. Required by /api/send-message. */
  fromNumber: string;
  quotaStore: QuotaStore;
  summarizer?: SendSmsSummarizer;
  now?: () => number;
}

let injectedDeps: SendSmsDeps | null = null;
export function setSendSmsDeps(deps: SendSmsDeps | null): void {
  injectedDeps = deps;
}

function defaultDeps(ctx: WorkerToolContext): SendSmsDeps {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  const fromNumber = process.env.SENDBLUE_FROM_NUMBER;
  if (!apiKey) throw new Error("send_sms: SENDBLUE_API_KEY env not set");
  if (!apiSecret) throw new Error("send_sms: SENDBLUE_API_SECRET env not set");
  if (!fromNumber) throw new Error("send_sms: SENDBLUE_FROM_NUMBER env not set");
  if (!ctx.quotaStore) {
    throw new Error("send_sms: quotaStore missing on WorkerToolContext");
  }
  return {
    fetch: globalThis.fetch,
    apiKey,
    apiSecret,
    fromNumber,
    quotaStore: ctx.quotaStore,
  };
}

export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded";
  constructor(
    readonly channel: "sms" | "email" | "artifact",
    readonly cap: number,
  ) {
    super(`quota_exceeded: ${channel} cap=${cap}`);
    this.name = "QuotaExceededError";
  }
}

async function sendOne(
  deps: SendSmsDeps,
  to: string,
  content: string,
  mediaUrl: string | undefined,
): Promise<SendblueSendResponse> {
  const res = await deps.fetch(SENDBLUE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Sendblue's documented direct-auth headers. (The SENDBLUE_SIGNING_SECRET
      // is only used by the API service to verify inbound webhooks; outbound
      // sends use these two key/secret headers.)
      "sb-api-key-id": deps.apiKey,
      "sb-api-secret-key": deps.apiSecret,
    },
    body: JSON.stringify({
      number: to,
      from_number: deps.fromNumber,
      content,
      ...(mediaUrl ? { media_url: mediaUrl } : {}),
    }),
  });
  const ok = res.status >= 200 && res.status < 300;
  let parsed: SendblueSendResponse;
  try {
    parsed = (await res.json()) as SendblueSendResponse;
  } catch {
    parsed = {};
  }
  // Sendblue sometimes returns 200 with error_message populated and no
  // message_handle (e.g. validation rejects pre-queue). Treat those as
  // failures so callers get a clean output_failed.
  const sendBlueErr =
    (!parsed.status || parsed.status === "ERROR") &&
    (errorMessageOf(parsed) || !messageHandleOf(parsed));
  if (!ok || sendBlueErr) {
    const err = new Error(
      `sendblue_http_${res.status}: ${errorMessageOf(parsed) ?? "no body"}`,
    );
    (err as { code?: string }).code =
      errorCodeOf(parsed) ?? `http_${res.status}`;
    throw err;
  }
  return parsed;
}

function isSmsFallback(r: SendblueSendResponse): boolean {
  if (wasDowngradedOf(r)) return true;
  if (sendStyleOf(r) === "SMS") return true;
  return false;
}

export const send_sms = defineTool({
  name: "send_sms",
  description:
    "Send an SMS / iMessage via Sendblue. `to` must be an E.164 phone number (e.g. `+15551234567`). For long bodies (>160 chars) that downgrade to SMS, a 140-char summary is sent as a follow-up message and both message IDs are returned.",
  params: ParamsSchema,
  mutating: true,
  approval: (args) => sendSmsApproval({ to: args.to, body: args.body }),
  cost: "low",
  execute: async (input, ctx: WorkerToolContext) => {
    const { to, body, mediaUrl } = ParamsSchema.parse(input);
    const deps = injectedDeps ?? defaultDeps(ctx);

    const allowed = await deps.quotaStore.increment(
      ctx.workspaceId,
      "sms",
      SEND_SMS_QUOTA_CAP,
    );
    if (!allowed) throw new QuotaExceededError("sms", SEND_SMS_QUOTA_CAP);

    const startedAt = (deps.now ?? Date.now)();

    let primary: SendblueSendResponse;
    try {
      primary = await sendOne(deps, to, body, mediaUrl);
    } catch (err) {
      const error = err as { code?: string; message?: string };
      await ctx.publish({
        type: "output_failed",
        payload: {
          kind: "output_failed",
          channel: "sms",
          error: {
            code: error.code ?? "sendblue_send_failed",
            message: error.message ?? "unknown",
          },
          retriable: true,
        },
      });
      throw err;
    }

    // SMS-fallback long-body path: send a second short message with a
    // summary so the recipient sees the gist even after carrier truncation.
    let summaryHandle: string | undefined;
    let summaryContent: string | undefined;
    if (isSmsFallback(primary) && body.length > SMS_LONG_THRESHOLD) {
      const summarize = deps.summarizer ?? defaultSendSmsSummarizer;
      summaryContent = await summarize(body);
      try {
        const summaryRes = await sendOne(
          deps,
          to,
          summaryContent,
          undefined,
        );
        summaryHandle = messageHandleOf(summaryRes);
      } catch (err) {
        // Don't fail the whole tool on summary failure — the primary
        // message already sent. Report it as a non-fatal output_failed.
        const error = err as { code?: string; message?: string };
        await ctx.publish({
          type: "output_failed",
          payload: {
            kind: "output_failed",
            channel: "sms",
            error: {
              code: error.code ?? "sendblue_summary_failed",
              message: error.message ?? "unknown",
            },
            retriable: true,
          },
        });
      }
    }

    const latencyMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
    const contentHash = `sha256-${createHash("sha256")
      .update(new Uint8Array(Buffer.from(body, "utf8")))
      .digest("hex")}`;

    await ctx.publish({
      type: "output_dispatched",
      payload: {
        kind: "output_dispatched",
        channel: "sms",
        recipient_or_key: to,
        content_hash: contentHash,
        attempt: 1,
        latency_ms: latencyMs,
      },
    });

    return {
      kind: "json" as const,
      json: {
        messageHandle: messageHandleOf(primary),
        sendStyle: sendStyleOf(primary),
        wasDowngraded: wasDowngradedOf(primary),
        summaryHandle,
        summaryContent,
      },
    };
  },
});

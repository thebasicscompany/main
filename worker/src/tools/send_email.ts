import { defineTool } from "@basics/shared";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import {
  S3Client,
  GetObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { WorkerToolContext } from "./context.js";
import type { QuotaStore } from "../quota-store.js";
import { sendEmailApproval } from "../approvals/policy.js";

// Daily per-workspace cap for outbound email. The increment_output_quota
// function in Supabase enforces this server-side; cap is passed in so
// the value lives next to the call site for observability.
export const SEND_EMAIL_QUOTA_CAP = 200;

// MIME-attached payloads above this size are converted to a 7-day
// signed-URL link appended to the email body instead. Keeps the raw
// MIME under SES's 40 MB limit and avoids bouncing recipients with
// strict size policies.
export const ATTACHMENT_INLINE_LIMIT_BYTES = 100 * 1024;

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const CONFIGURATION_SET = "basics-runtime-outbound";

// RFC 5322 — keep the regex generous enough for real-world addresses
// but strict enough to refuse obvious garbage. Defense-in-depth; SES
// itself will reject malformed addresses.
const EmailAddrSchema = z
  .string()
  .min(3)
  .max(320)
  .refine((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), "invalid email");

// Filename used inside `Content-Disposition: attachment; filename="…"` and
// the MIME `name=` param. Rejects characters that would break out of the
// quoted-string (`"`, `\`, CR, LF) — a CRLF in a filename would otherwise
// inject arbitrary headers into the MIME envelope (e.g. Bcc: attacker).
const FilenameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) => !/[\r\n"\\]/.test(s),
    'filename must not contain CR, LF, ", or \\',
  );

const AttachmentSchema = z.object({
  s3Key: z.string().min(1).max(1024).refine(
    (s) => !/[\r\n]/.test(s),
    "s3Key must not contain CR or LF",
  ),
  filename: FilenameSchema.optional(),
});

const ParamsSchema = z.object({
  to: z.union([EmailAddrSchema, z.array(EmailAddrSchema).min(1).max(50)]),
  // CRLF in a Subject line escapes the header and lets a malicious or
  // hallucinated value inject Bcc/Cc/Content-Type headers into the raw MIME.
  subject: z
    .string()
    .min(1)
    .max(998)
    .refine(
      (s) => !/[\r\n]/.test(s),
      "subject must not contain CR or LF",
    ),
  body: z.string().min(1).max(1 * 1024 * 1024),
  bodyType: z.enum(["text", "html"]).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded";
  constructor(
    readonly channel: "email" | "sms" | "artifact",
    readonly cap: number,
  ) {
    super(`quota_exceeded: ${channel} cap=${cap}`);
    this.name = "QuotaExceededError";
  }
}

function detectBodyType(body: string): "text" | "html" {
  return body.slice(0, 200).includes("<") ? "html" : "text";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface ResolvedAttachment {
  s3Key: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

interface OversizedAttachment {
  s3Key: string;
  filename: string;
  byteLength: number;
  signedUrl: string;
}

function buildMimeRaw(
  fromEmail: string,
  to: string[],
  subject: string,
  body: string,
  bodyType: "text" | "html",
  attachments: ResolvedAttachment[],
): Buffer {
  const boundary = `mixed_${createHash("sha1")
    .update(`${Date.now()}_${Math.random()}`)
    .digest("hex")
    .slice(0, 16)}`;
  const lines: string[] = [];
  lines.push(`From: ${fromEmail}`);
  lines.push(`To: ${to.join(", ")}`);
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");
  lines.push(`--${boundary}`);
  lines.push(
    bodyType === "html"
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
  );
  // Encode the body as base64 so UTF-8 + arbitrary characters survive
  // through SMTP without trampling the 7-bit line-length rules. The
  // Content-Transfer-Encoding declaration tells receivers how to decode.
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(
    Buffer.from(body, "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n"),
  );
  lines.push("");
  for (const att of attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.contentType}; name="${att.filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(
      `Content-Disposition: attachment; filename="${att.filename}"`,
    );
    lines.push("");
    // Fold base64 to 76 chars per line per RFC 2045.
    const b64 = att.bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
    lines.push(b64);
  }
  lines.push(`--${boundary}--`);
  return Buffer.from(lines.join("\r\n"), "utf8");
}

export interface SendEmailDeps {
  ses: { send: (cmd: SendEmailCommand) => Promise<{ MessageId?: string }> };
  s3: {
    send: (cmd: GetObjectCommand) => Promise<GetObjectCommandOutput>;
    config: SESv2Client["config"];
  };
  bucket: string;
  fromEmail: string;
  quotaStore: QuotaStore;
  signedUrlFactory?: (
    s3: unknown,
    cmd: GetObjectCommand,
    opts: { expiresIn: number },
  ) => Promise<string>;
  now?: () => number;
}

let injectedDeps: SendEmailDeps | null = null;
/** Test-only seam. Pass null to restore default lazy initialisation. */
export function setSendEmailDeps(deps: SendEmailDeps | null): void {
  injectedDeps = deps;
}

function defaultDeps(ctx: WorkerToolContext): SendEmailDeps {
  const bucket = process.env.ARTIFACTS_S3_BUCKET;
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!bucket) throw new Error("send_email: ARTIFACTS_S3_BUCKET env not set");
  if (!fromEmail) throw new Error("send_email: SES_FROM_EMAIL env not set");
  if (!ctx.quotaStore) {
    throw new Error("send_email: quotaStore missing on WorkerToolContext");
  }
  const region = process.env.AWS_REGION ?? "us-east-1";
  return {
    ses: new SESv2Client({ region }),
    s3: new S3Client({ region }) as unknown as SendEmailDeps["s3"],
    bucket,
    fromEmail,
    quotaStore: ctx.quotaStore,
  };
}

async function streamToBuffer(
  body: GetObjectCommandOutput["Body"],
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const maybe = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  } & AsyncIterable<Uint8Array>;
  if (typeof maybe.transformToByteArray === "function") {
    const bytes = await maybe.transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of maybe) {
    chunks.push(new Uint8Array(chunk));
  }
  return Buffer.concat(chunks);
}

function inferContentTypeFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  return "application/octet-stream";
}

export const send_email = defineTool({
  name: "send_email",
  description:
    "Send an email via Amazon SES from the workspace's runtime-outbound identity. `to` may be a single address or array (max 50). Body type autodetects HTML if `<` appears in the first 200 chars; override with bodyType. Attachments are referenced by s3Key under the artifacts bucket; payloads >100 KB are inlined as 7-day signed-URL links instead of MIME-attached.",
  params: ParamsSchema,
  mutating: true,
  approval: (args) => sendEmailApproval({ to: args.to }),
  cost: "low",
  effects: "mutating-outbound",
  execute: async (input, ctx: WorkerToolContext) => {
    const { to, subject, body, bodyType, attachments } =
      ParamsSchema.parse(input);
    const deps = injectedDeps ?? defaultDeps(ctx);

    const recipients = Array.isArray(to) ? to : [to];
    const resolvedBodyType = bodyType ?? detectBodyType(body);

    // Quota gate FIRST — refuse without sending if exceeded.
    const allowed = await deps.quotaStore.increment(
      ctx.workspaceId,
      "email",
      SEND_EMAIL_QUOTA_CAP,
    );
    if (!allowed) {
      throw new QuotaExceededError("email", SEND_EMAIL_QUOTA_CAP);
    }

    const startedAt = (deps.now ?? Date.now)();

    // Pull attachments from S3, splitting into inline-link vs MIME-attach.
    const inlineAtts: ResolvedAttachment[] = [];
    const linkedAtts: OversizedAttachment[] = [];
    if (attachments && attachments.length > 0) {
      const sign = deps.signedUrlFactory ?? getSignedUrl;
      for (const att of attachments) {
        const obj = await deps.s3.send(
          new GetObjectCommand({ Bucket: deps.bucket, Key: att.s3Key }),
        );
        const bytes = await streamToBuffer(obj.Body);
        // Derived filenames (from s3Key when att.filename is absent) bypass
        // FilenameSchema, so strip any chars that could break out of the
        // quoted-string in Content-Disposition before interpolating.
        const rawFilename =
          att.filename ?? att.s3Key.split("/").pop() ?? "attachment";
        const filename = rawFilename.replace(/[\r\n"\\]/g, "_");
        if (bytes.byteLength > ATTACHMENT_INLINE_LIMIT_BYTES) {
          const signedUrl = await sign(
            deps.s3 as unknown as S3Client,
            new GetObjectCommand({ Bucket: deps.bucket, Key: att.s3Key }),
            { expiresIn: SIGNED_URL_TTL_SECONDS },
          );
          linkedAtts.push({
            s3Key: att.s3Key,
            filename,
            byteLength: bytes.byteLength,
            signedUrl,
          });
        } else {
          inlineAtts.push({
            s3Key: att.s3Key,
            filename,
            contentType:
              obj.ContentType ?? inferContentTypeFromFilename(filename),
            bytes,
          });
        }
      }
    }

    // If we have linked attachments, append a links section to the body.
    let finalBody = body;
    if (linkedAtts.length > 0) {
      if (resolvedBodyType === "html") {
        const links = linkedAtts
          .map(
            (a) =>
              `<li><a href="${a.signedUrl}">${escapeHtml(a.filename)}</a> (${a.byteLength} bytes)</li>`,
          )
          .join("");
        finalBody += `\r\n<hr/><p>Attachments (7-day links):</p><ul>${links}</ul>`;
      } else {
        const lines = linkedAtts.map(
          (a) => `- ${a.filename} (${a.byteLength} bytes): ${a.signedUrl}`,
        );
        finalBody += `\r\n\r\n---\r\nAttachments (7-day links):\r\n${lines.join("\r\n")}`;
      }
    }

    // Build the SendEmail command. SESv2 supports Simple vs Raw content
    // shapes; choose Raw only when we have actual MIME attachments to bundle.
    let cmd: SendEmailCommand;
    if (inlineAtts.length > 0) {
      const raw = buildMimeRaw(
        deps.fromEmail,
        recipients,
        subject,
        finalBody,
        resolvedBodyType,
        inlineAtts,
      );
      cmd = new SendEmailCommand({
        FromEmailAddress: deps.fromEmail,
        Destination: { ToAddresses: recipients },
        Content: {
          Raw: {
            Data: new Uint8Array(
              raw.buffer,
              raw.byteOffset,
              raw.byteLength,
            ),
          },
        },
        ConfigurationSetName: CONFIGURATION_SET,
      });
    } else {
      cmd = new SendEmailCommand({
        FromEmailAddress: deps.fromEmail,
        Destination: { ToAddresses: recipients },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body:
              resolvedBodyType === "html"
                ? { Html: { Data: finalBody, Charset: "UTF-8" } }
                : { Text: { Data: finalBody, Charset: "UTF-8" } },
          },
        },
        ConfigurationSetName: CONFIGURATION_SET,
      });
    }

    let messageId: string | undefined;
    try {
      const res = await deps.ses.send(cmd);
      messageId = res.MessageId;
    } catch (err) {
      const error = err as { name?: string; message?: string };
      await ctx.publish({
        type: "output_failed",
        payload: {
          kind: "output_failed",
          channel: "email",
          error: {
            code: error.name ?? "ses_send_failed",
            message: error.message ?? "unknown",
          },
          retriable: true,
        },
      });
      throw err;
    }

    const latencyMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
    const contentHash = `sha256-${createHash("sha256")
      .update(new Uint8Array(Buffer.from(`${subject}\n${finalBody}`, "utf8")))
      .digest("hex")}`;

    await ctx.publish({
      type: "output_dispatched",
      payload: {
        kind: "output_dispatched",
        channel: "email",
        recipient_or_key: recipients.join(","),
        content_hash: contentHash,
        attempt: 1,
        latency_ms: latencyMs,
      },
    });

    return {
      kind: "json" as const,
      json: {
        messageId,
        recipients,
        bodyType: resolvedBodyType,
        attachmentsAttached: inlineAtts.length,
        attachmentsLinked: linkedAtts.map((a) => ({
          s3Key: a.s3Key,
          filename: a.filename,
          byteLength: a.byteLength,
        })),
        configurationSet: CONFIGURATION_SET,
      },
    };
  },
});

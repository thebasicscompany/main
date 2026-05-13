import { defineTool } from "@basics/shared";
import { capture_screenshot } from "@basics/harness";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { WorkerToolContext } from "./context.js";

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

let cachedS3: S3Client | null = null;
function getS3(): S3Client {
  if (!cachedS3) {
    cachedS3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return cachedS3;
}

export const screenshot = defineTool({
  name: "screenshot",
  description:
    "Capture a PNG screenshot of the current tab and persist it to the runtime artifacts bucket. Returns an `s3Key` and a 7-day `signedUrl` you can pass directly to `send_email.attachments` or share with a human. The image bytes themselves are not echoed back into the model context — use the s3Key to reference them. Set `full: true` to capture beyond the viewport. Pass an explicit `name` to override the auto-generated filename.",
  params: z.object({
    full: z.boolean().optional(),
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._-]+$/, "name must be safe filename chars")
      .optional(),
  }),
  mutating: false,
  cost: "medium",
  execute: async ({ full, name }, ctx: WorkerToolContext) => {
    const r = await capture_screenshot(ctx.session, { full });
    const buf = Buffer.from(r.base64, "base64");
    const byteLength = buf.byteLength;

    const filename = name ?? `${randomUUID()}.png`;
    const s3Key = `workspaces/${ctx.workspaceId}/runs/${ctx.runId}/screenshots/${filename}`;

    const bucket = process.env.ARTIFACTS_S3_BUCKET;
    let signedUrl: string | undefined;
    if (bucket) {
      // Best-effort upload — if S3 fails we still return the b64 so existing
      // visual workflows (extract/js consumers) keep working without it.
      try {
        const s3 = getS3();
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
            ContentType: `image/${r.format}`,
          }),
        );
        signedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
          { expiresIn: SIGNED_URL_TTL_SECONDS },
        );
      } catch (err) {
        console.error(
          "screenshot: S3 persist failed; returning b64 only",
          (err as Error).message,
        );
      }
    }

    return {
      kind: "image" as const,
      b64: r.base64,
      mimeType: `image/${r.format}`,
      ...(bucket ? { s3Key } : {}),
      ...(signedUrl ? { signedUrl } : {}),
      byteLength,
    };
  },
});

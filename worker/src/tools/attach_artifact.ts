import { defineTool } from "@basics/shared";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { WorkerToolContext } from "./context.js";

// 25 MiB hard cap on the decoded payload — large enough for screenshots
// and small exports, small enough to keep an SES inline limit-friendly
// fallback workable. Lifted to a constant so the test can reference it.
export const ATTACH_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

const NameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (n) =>
      !n.includes("/") &&
      !n.includes("\\") &&
      !n.includes("..") &&
      n.trim() === n &&
      n[0] !== ".",
    "name must be a single path segment without `..`, `/`, `\\`, or leading dot",
  );

const ParamsSchema = z.object({
  name: NameSchema,
  payload: z.string().min(1),
  contentType: z.string().min(1).max(200).optional(),
});

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

// Detect a base64-encoded payload. base64 strings:
//   - contain only [A-Za-z0-9+/=]
//   - have length divisible by 4 once padded
// Otherwise we treat the input as raw UTF-8.
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
function decodePayload(payload: string): Buffer {
  const stripped = payload.replace(/\s+/g, "");
  if (
    stripped.length > 0 &&
    stripped.length % 4 === 0 &&
    BASE64_REGEX.test(stripped)
  ) {
    return Buffer.from(stripped, "base64");
  }
  return Buffer.from(payload, "utf8");
}

export interface AttachArtifactDeps {
  s3: Pick<S3Client, "send" | "config">;
  bucket: string;
  now?: () => number;
  signedUrlFactory?: (
    s3: AttachArtifactDeps["s3"],
    cmd: GetObjectCommand,
    opts: { expiresIn: number },
  ) => Promise<string>;
}

function defaultDeps(): AttachArtifactDeps {
  const bucket = process.env.ARTIFACTS_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "attach_artifact: ARTIFACTS_S3_BUCKET env not set on the worker task",
    );
  }
  return {
    s3: new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" }),
    bucket,
  };
}

let injectedDeps: AttachArtifactDeps | null = null;
/** Test-only seam. Pass null to restore default lazy initialisation. */
export function setAttachArtifactDeps(deps: AttachArtifactDeps | null): void {
  injectedDeps = deps;
}

export const attach_artifact = defineTool({
  name: "attach_artifact",
  description:
    "Persist a payload to the runtime artifacts bucket under workspaces/<workspaceId>/runs/<runId>/<name> and return a 7-day signed URL. Useful for attaching screenshots, exports, or other binary outputs to a run.",
  params: ParamsSchema,
  mutating: true,
  cost: "low",
  execute: async (input, ctx: WorkerToolContext) => {
    // Belt-and-braces param validation. The OC adapter normally Zod-parses
    // before dispatch, but defensive parsing here keeps the file-system
    // safety properties (no `..`, no path separators, ≤200 chars) true
    // even when callers reach the tool through a different surface.
    const { name, payload, contentType } = ParamsSchema.parse(input);
    const deps = injectedDeps ?? defaultDeps();
    const body = decodePayload(payload);
    if (body.byteLength > ATTACH_ARTIFACT_MAX_BYTES) {
      throw new Error(
        `attach_artifact: payload too large (${body.byteLength} bytes, max ${ATTACH_ARTIFACT_MAX_BYTES})`,
      );
    }

    const s3Key = `workspaces/${ctx.workspaceId}/runs/${ctx.runId}/${name}`;
    const resolvedContentType = contentType ?? "application/octet-stream";
    const startedAt = (deps.now ?? Date.now)();

    try {
      await deps.s3.send(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: s3Key,
          Body: body,
          ContentType: resolvedContentType,
        }),
      );
    } catch (err) {
      const error = err as Error;
      await ctx.publish({
        type: "output_failed",
        payload: {
          kind: "output_failed",
          channel: "artifact",
          error: {
            code: "s3_put_failed",
            message: error.message ?? "unknown",
          },
          retriable: true,
        },
      });
      throw err;
    }

    const sign = deps.signedUrlFactory ?? getSignedUrl;
    const signedUrl = await sign(
      deps.s3 as S3Client,
      new GetObjectCommand({ Bucket: deps.bucket, Key: s3Key }),
      { expiresIn: SEVEN_DAYS_SECONDS },
    );

    const contentHash = `sha256-${createHash("sha256")
      .update(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      .digest("hex")}`;
    const latencyMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);

    await ctx.publish({
      type: "output_dispatched",
      payload: {
        kind: "output_dispatched",
        channel: "artifact",
        recipient_or_key: s3Key,
        content_hash: contentHash,
        attempt: 1,
        latency_ms: latencyMs,
      },
    });

    return {
      kind: "json" as const,
      json: { s3Key, signedUrl, byteLength: body.byteLength, contentHash },
    };
  },
});

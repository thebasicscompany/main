import { afterEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  attach_artifact,
  setAttachArtifactDeps,
  ATTACH_ARTIFACT_MAX_BYTES,
} from "./attach_artifact.js";

interface CapturedPut {
  bucket?: string;
  key?: string;
  body?: Buffer;
  contentType?: string;
}

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

function makeFakeS3(captured: CapturedPut, putShouldThrow?: Error) {
  return {
    send: async (cmd: PutObjectCommand | GetObjectCommand) => {
      if (cmd instanceof PutObjectCommand) {
        if (putShouldThrow) throw putShouldThrow;
        captured.bucket = cmd.input.Bucket;
        captured.key = cmd.input.Key;
        captured.body = Buffer.isBuffer(cmd.input.Body)
          ? cmd.input.Body
          : Buffer.from(cmd.input.Body as Uint8Array);
        captured.contentType = cmd.input.ContentType;
        return {} as never;
      }
      return {} as never;
    },
    config: { region: () => "us-east-1" } as never,
  };
}

afterEach(() => {
  setAttachArtifactDeps(null);
});

describe("attach_artifact", () => {
  it("uploads a ~1 KB utf-8 payload and emits output_dispatched", async () => {
    const captured: CapturedPut = {};
    const fakeS3 = makeFakeS3(captured);
    setAttachArtifactDeps({
      s3: fakeS3,
      bucket: "basics-runtime-artifacts-test",
      signedUrlFactory: async () => "https://signed.example/artifact",
      now: (() => {
        let t = 1_000_000;
        return () => (t += 5);
      })(),
    });

    const body = JSON.stringify({ ok: true, padding: "x".repeat(900) });
    const { events, ctx } = makeCtx();
    const result = await attach_artifact.execute(
      { name: "test.json", payload: body, contentType: "application/json" },
      ctx,
    );

    expect(result.kind).toBe("json");
    const json = (result as { kind: "json"; json: Record<string, unknown> }).json;
    expect(json.s3Key).toBe("workspaces/ws_test/runs/run_test/test.json");
    expect(json.signedUrl).toBe("https://signed.example/artifact");
    expect(json.byteLength).toBe(Buffer.byteLength(body, "utf8"));
    expect(String(json.contentHash)).toMatch(/^sha256-[0-9a-f]{64}$/);

    expect(captured.bucket).toBe("basics-runtime-artifacts-test");
    expect(captured.key).toBe("workspaces/ws_test/runs/run_test/test.json");
    expect(captured.contentType).toBe("application/json");
    expect(captured.body?.toString("utf8")).toBe(body);

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("output_dispatched");
    expect(evt.payload).toMatchObject({
      kind: "output_dispatched",
      channel: "artifact",
      recipient_or_key: "workspaces/ws_test/runs/run_test/test.json",
      attempt: 1,
    });
    expect(evt.payload.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("decodes a base64 payload and stores the raw bytes", async () => {
    const captured: CapturedPut = {};
    setAttachArtifactDeps({
      s3: makeFakeS3(captured),
      bucket: "b",
      signedUrlFactory: async () => "https://signed.example/x",
    });

    const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const { ctx } = makeCtx();
    await attach_artifact.execute(
      { name: "blob.bin", payload: raw.toString("base64") },
      ctx,
    );

    expect(captured.body?.toString("hex")).toBe(raw.toString("hex"));
  });

  it("rejects an oversized payload before calling S3", async () => {
    const captured: CapturedPut = {};
    const send = vi.fn();
    setAttachArtifactDeps({
      s3: { send, config: {} as never } as never,
      bucket: "b",
      signedUrlFactory: async () => "x",
    });

    // ATTACH_ARTIFACT_MAX_BYTES + 1 UTF-8 chars → exceeds the cap.
    const huge = "a".repeat(ATTACH_ARTIFACT_MAX_BYTES + 1);
    const { ctx } = makeCtx();
    await expect(
      attach_artifact.execute({ name: "big.txt", payload: huge }, ctx),
    ).rejects.toThrow(/payload too large/);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["../escape.txt", "double-dot"],
    ["nested/dir.txt", "forward slash"],
    ["nested\\dir.txt", "backslash"],
    [".hidden", "leading dot"],
    [" leading-space.txt", "leading whitespace"],
    ["a".repeat(201), "over 200 chars"],
  ])("rejects malformed name %s (%s)", async (badName) => {
    setAttachArtifactDeps({
      s3: makeFakeS3({}),
      bucket: "b",
      signedUrlFactory: async () => "x",
    });
    const { ctx } = makeCtx();
    await expect(
      attach_artifact.execute({ name: badName, payload: "hello" }, ctx),
    ).rejects.toThrow();
  });

  it("emits output_failed and propagates when S3 PutObject fails", async () => {
    setAttachArtifactDeps({
      s3: makeFakeS3({}, new Error("AccessDenied")),
      bucket: "b",
      signedUrlFactory: async () => "x",
    });

    const { events, ctx } = makeCtx();
    await expect(
      attach_artifact.execute({ name: "x.txt", payload: "hello" }, ctx),
    ).rejects.toThrow(/AccessDenied/);

    expect(events).toHaveLength(1);
    const failEvt = events[0]!;
    expect(failEvt.type).toBe("output_failed");
    expect(failEvt.payload).toMatchObject({
      kind: "output_failed",
      channel: "artifact",
      retriable: true,
      error: { code: "s3_put_failed" },
    });
  });
});

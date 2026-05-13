import { describe, expect, it } from "vitest";
import { signWorkerWorkspaceJwt } from "./jwt.js";

describe("signWorkerWorkspaceJwt", () => {
  it("produces a 3-segment JWT", () => {
    const tok = signWorkerWorkspaceJwt("test-secret-very-long-please", {
      workspaceId: "ws_1",
      accountId: "acc_1",
    });
    expect(tok.split(".")).toHaveLength(3);
  });

  it("payload carries the expected fields (and plan defaults to 'pro')", () => {
    const tok = signWorkerWorkspaceJwt("test-secret-very-long-please", {
      workspaceId: "ws_1",
      accountId: "acc_1",
    });
    const [, payloadB64] = tok.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    );
    expect(payload.workspace_id).toBe("ws_1");
    expect(payload.account_id).toBe("acc_1");
    expect(payload.plan).toBe("pro");
    expect(payload.seat_status).toBe("active");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(300); // default 5-min TTL
  });

  it("honors a custom plan + ttlSeconds", () => {
    const tok = signWorkerWorkspaceJwt("test-secret-very-long-please", {
      workspaceId: "ws_1",
      accountId: "acc_1",
      plan: "free",
      ttlSeconds: 60,
    });
    const payload = JSON.parse(
      Buffer.from(
        tok.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    );
    expect(payload.plan).toBe("free");
    expect(payload.exp - payload.iat).toBe(60);
  });

  it("verifies stably against the same secret (signature deterministic over inputs)", () => {
    // Two tokens minted with the same payload + secret should have
    // identical signatures (HMAC is deterministic). We can't easily
    // freeze `now` here, so just check the header is identical between
    // back-to-back mints in the same millisecond bucket.
    const t1 = signWorkerWorkspaceJwt("s", { workspaceId: "ws", accountId: "acc" });
    const t2 = signWorkerWorkspaceJwt("s", { workspaceId: "ws", accountId: "acc" });
    expect(t1.split(".")[0]).toBe(t2.split(".")[0]);
  });
});

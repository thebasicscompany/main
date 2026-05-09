// BUILD-LOOP C.4 — BYO key resolution.
// The worker side of §6.2 BYO. Encrypt/decrypt + storage policy is api-owned
// per §0.1; this module is the consumer that picks BYO when present and
// falls back to the platform env otherwise.

import { describe, expect, it } from "vitest";
import {
  HttpBYOKeyResolver,
  InMemoryBYOKeyResolver,
  resolveKeyForProvider,
  type BYOKeySet,
} from "../src/byok-resolver.js";

describe("resolveKeyForProvider — fallback semantics", () => {
  const PLATFORM_ENV = {
    ANTHROPIC_API_KEY: "platform-anth",
    GEMINI_API_KEY: "platform-gem",
    OPENAI_API_KEY: "platform-oai",
  };

  it("BYO key wins when set", () => {
    const r = resolveKeyForProvider("anthropic", { anthropic: "byo-anth" }, PLATFORM_ENV);
    expect(r).toEqual({ provider: "anthropic", key: "byo-anth", source: "byo" });
  });

  it("falls back to platform env when BYO absent", () => {
    const r = resolveKeyForProvider("google", {}, PLATFORM_ENV);
    expect(r).toEqual({ provider: "google", key: "platform-gem", source: "platform" });
  });

  it("falls back to platform when BYO is empty string", () => {
    const r = resolveKeyForProvider("openai", { openai: "" }, PLATFORM_ENV);
    expect(r.source).toBe("platform");
    expect(r.key).toBe("platform-oai");
  });

  it("throws provider_unavailable when neither BYO nor platform is configured", () => {
    expect(() =>
      resolveKeyForProvider("anthropic", {}, { GEMINI_API_KEY: "x" }),
    ).toThrow(/provider_unavailable: anthropic/);
  });

  it("partial BYO: anthropic from BYO, google from platform, openai missing", () => {
    const byo: BYOKeySet = { anthropic: "byo-anth" };
    const env = { ANTHROPIC_API_KEY: "p-a", GEMINI_API_KEY: "p-g" };
    expect(resolveKeyForProvider("anthropic", byo, env).source).toBe("byo");
    expect(resolveKeyForProvider("google", byo, env).source).toBe("platform");
    expect(() => resolveKeyForProvider("openai", byo, env)).toThrow(/provider_unavailable: openai/);
  });
});

describe("InMemoryBYOKeyResolver", () => {
  it("returns the set for a workspace, empty for unknown ones", async () => {
    const r = new InMemoryBYOKeyResolver();
    r.set("ws-a", { anthropic: "k1", google: "k2" });
    expect(await r.resolve("ws-a")).toEqual({ anthropic: "k1", google: "k2" });
    expect(await r.resolve("ws-b")).toEqual({});
  });

  it("clear removes the entry", async () => {
    const r = new InMemoryBYOKeyResolver();
    r.set("ws", { openai: "k" });
    r.clear("ws");
    expect(await r.resolve("ws")).toEqual({});
  });
});

describe("HttpBYOKeyResolver", () => {
  it("issues GET /v1/runtime/byo-keys?workspace_id=… with service-role header", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fakeFetch: typeof fetch = async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : (input as URL).toString(),
        headers: { ...(init?.headers as Record<string, string>) },
      };
      return new Response(JSON.stringify({ anthropic: "byo-anth" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const r = new HttpBYOKeyResolver({
      apiBaseUrl: "https://api.trybasics.ai",
      serviceRoleToken: "tok-secret",
      fetchImpl: fakeFetch,
    });
    const keys = await r.resolve("ws-test");
    expect(keys).toEqual({ anthropic: "byo-anth" });
    expect(captured!.url).toBe("https://api.trybasics.ai/v1/runtime/byo-keys?workspace_id=ws-test");
    expect(captured!.headers["X-Service-Role-Token"]).toBe("tok-secret");
  });

  it("404 → empty set (workspace has no BYO row, fallback to platform)", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("not_found", { status: 404 });
    const r = new HttpBYOKeyResolver({
      apiBaseUrl: "https://api.trybasics.ai",
      serviceRoleToken: "tok",
      fetchImpl: fakeFetch,
    });
    expect(await r.resolve("ws")).toEqual({});
  });

  it("non-2xx (other than 404) throws byok_resolve_failed with status", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("boom", { status: 503 });
    const r = new HttpBYOKeyResolver({
      apiBaseUrl: "https://api.trybasics.ai",
      serviceRoleToken: "tok",
      fetchImpl: fakeFetch,
    });
    await expect(r.resolve("ws")).rejects.toThrow(/byok_resolve_failed: 503/);
  });

  it("strips empty / missing fields from the response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ anthropic: "k", google: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const r = new HttpBYOKeyResolver({
      apiBaseUrl: "https://api.trybasics.ai",
      serviceRoleToken: "tok",
      fetchImpl: fakeFetch,
    });
    expect(await r.resolve("ws")).toEqual({ anthropic: "k" });
  });
});

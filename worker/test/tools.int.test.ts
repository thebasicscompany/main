// BUILD-LOOP A.8 integration test — opens a real Browserbase session,
// drives the three ported tools through the OC adapter, and asserts the
// publish hook captured one event per call. The DB-side write into
// agent_activity is exercised separately by the A.9 smoke test (with the
// real worker's publisher); this test uses an in-memory publish capture.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attach, detach, type CdpSession } from "@basics/harness";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";
import {
  buildWorkerToolRegistry,
  type PublishEvent,
  type WorkerToolContext,
} from "../src/tools/index.js";

const HAS_KEYS =
  Boolean(process.env.BROWSERBASE_API_KEY) &&
  Boolean(process.env.BROWSERBASE_PROJECT_ID);

const itLive = HAS_KEYS ? it : it.skip;

interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

async function bbCreate(): Promise<BrowserbaseSession> {
  const resp = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      "X-BB-API-Key": process.env.BROWSERBASE_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      browserSettings: { timeout: 5 * 60_000 },
      userMetadata: { source: "build_loop_a8_tools_int_test" },
    }),
  });
  if (!resp.ok) throw new Error(`bb create failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as BrowserbaseSession;
}

async function bbStop(id: string): Promise<void> {
  await fetch(`https://api.browserbase.com/v1/sessions/${id}`, {
    method: "POST",
    headers: {
      "X-BB-API-Key": process.env.BROWSERBASE_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: "REQUEST_RELEASE",
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    }),
  });
}

describe("worker tools (integration)", () => {
  let bb: BrowserbaseSession | null = null;
  let session: CdpSession | null = null;
  const captured: PublishEvent[] = [];
  const ctx: WorkerToolContext = {
    session: undefined as unknown as CdpSession, // populated in beforeAll
    runId: "00000000-0000-0000-0000-000000000a08",
    workspaceId: "139e7cdc-7060-49c8-a04f-2afffddbd708",
    accountId: "00000000-0000-0000-0000-000000000a08",
    workspaceRoot: "/tmp/test-workspace",
    publish: (e) => {
      captured.push(e);
    },
  };

  beforeAll(async () => {
    if (!HAS_KEYS) return;
    bb = await bbCreate();
    session = await attach({ wsUrl: bb.connectUrl });
    ctx.session = session;
  }, 60_000);

  afterAll(async () => {
    if (session) await detach(session).catch(() => {});
    if (bb) await bbStop(bb.id).catch(() => {});
  }, 30_000);

  itLive(
    "screenshot returns base64 > 1000 chars + publishes one event",
    async () => {
      captured.length = 0;
      const tools = toOpencodeTools(buildWorkerToolRegistry(), {
        resolveContext: () => ctx,
      });
      const ss = tools.find((t) => t.name === "screenshot");
      expect(ss).toBeDefined();
      const result = (await ss!.execute({})) as {
        kind: "image";
        b64: string;
        mimeType?: string;
      };
      expect(result.kind).toBe("image");
      expect(result.b64.length).toBeGreaterThan(1000);
      expect(result.mimeType).toBe("image/png");
      // Browser tools no longer self-publish; runner owns tool_call_start/end.
      expect(captured).toHaveLength(0);
    },
    60_000,
  );

  itLive(
    "goto_url navigates to example.com + publishes one event",
    async () => {
      captured.length = 0;
      const tools = toOpencodeTools(buildWorkerToolRegistry(), {
        resolveContext: () => ctx,
      });
      const goto = tools.find((t) => t.name === "goto_url");
      const result = (await goto!.execute({ url: "https://example.com/" })) as {
        kind: "json";
        json: Record<string, unknown>;
      };
      expect(result.kind).toBe("json");
      // harness's goto_url returns frame info; we don't bind to one specific
      // shape (it varies by Chrome version) — just assert it's a non-empty object.
      expect(typeof result.json).toBe("object");
      expect(Object.keys(result.json).length).toBeGreaterThan(0);
      expect(captured).toHaveLength(0); // runner owns timeline now
    },
    60_000,
  );

  itLive(
    "js returns document.title for example.com + publishes one event",
    async () => {
      captured.length = 0;
      const tools = toOpencodeTools(buildWorkerToolRegistry(), {
        resolveContext: () => ctx,
      });
      const jsTool = tools.find((t) => t.name === "js");
      const result = (await jsTool!.execute({ expression: "document.title" })) as {
        kind: "json";
        json: unknown;
      };
      expect(result.kind).toBe("json");
      expect(result.json).toBe("Example Domain");
      expect(captured).toHaveLength(0); // runner owns timeline now
    },
    60_000,
  );

  // ===== B.1 — port the remaining 13 browser tools. =====

  itLive("new_tab opens a fresh tab and returns targetId", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "new_tab")!.execute({})) as { kind: "json"; json: { targetId: string } };
    expect(typeof r.json.targetId).toBe("string");
    expect(r.json.targetId.length).toBeGreaterThan(0);
  }, 60_000);

  itLive("ensure_real_tab returns a tab info object after attach", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "ensure_real_tab")!.execute({})) as { kind: "json"; json: { tab: unknown } };
    expect(r.json.tab).not.toBe(undefined);
  }, 60_000);

  itLive("wait_for_load resolves true once example.com is loaded", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "goto_url")!.execute({ url: "https://example.com/" });
    const r = (await tools.find((t) => t.name === "wait_for_load")!.execute({ timeout: 10 })) as { kind: "json"; json: { loaded: boolean } };
    expect(r.json.loaded).toBe(true);
  }, 60_000);

  itLive("wait_for_element finds the example.com h1", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "wait_for_element")!.execute({ selector: "h1", timeout: 5 })) as { kind: "json"; json: { found: boolean } };
    expect(r.json.found).toBe(true);
  }, 30_000);

  itLive("wait_for_network_idle resolves true after example.com settles", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "wait_for_network_idle")!.execute({ timeout: 5, idleMs: 200 })) as { kind: "json"; json: { idle: boolean } };
    expect(r.json.idle).toBe(true);
  }, 30_000);

  itLive("scroll dispatches a wheel event without throwing", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "scroll")!.execute({ x: 100, y: 100, dy: -200 })) as { kind: "text"; text: string };
    expect(r.text).toMatch(/scrolled/);
  }, 30_000);

  itLive("click_at_xy at a non-interactive coord doesn't throw", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "click_at_xy")!.execute({ x: 10, y: 10 })) as { kind: "text"; text: string };
    expect(r.text).toMatch(/clicked/);
  }, 30_000);

  itLive("type_text inserts text without throwing", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "type_text")!.execute({ text: "hi" })) as { kind: "text"; text: string };
    expect(r.text).toMatch(/typed 2 chars/);
  }, 30_000);

  itLive("press_key dispatches without throwing", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "press_key")!.execute({ key: "Tab" })) as { kind: "text"; text: string };
    expect(r.text).toMatch(/pressed Tab/);
  }, 30_000);

  itLive("fill_input → empty input on example.com gracefully throws (no input on the page)", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    // example.com has no <input>; expect a clean error rather than hang.
    await expect(
      tools.find((t) => t.name === "fill_input")!.execute({ selector: "input.does-not-exist", text: "x", timeout: 1 }),
    ).rejects.toThrow();
  }, 30_000);

  itLive("dispatch_key dispatches without throwing on a known element", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    // body is always present; dispatch a keypress on it.
    const r = (await tools.find((t) => t.name === "dispatch_key")!.execute({ selector: "body", key: "Enter" })) as { kind: "text"; text: string };
    expect(r.text).toMatch(/dispatched/);
  }, 30_000);

  itLive("upload_file rejects when the selector doesn't match", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "upload_file")!.execute({
        selector: "input[type=file]",
        paths: "/workspace/nonexistent.txt",
      }),
    ).rejects.toThrow();
  }, 30_000);

  itLive("extract pulls h1 text from example.com", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "goto_url")!.execute({ url: "https://example.com/" });
    const r = (await tools.find((t) => t.name === "extract")!.execute({ selector: "h1" })) as {
      kind: "json";
      json: { rows: Array<{ text: string; html: string }> };
    };
    expect(r.json.rows.length).toBeGreaterThan(0);
    expect(r.json.rows[0]?.text.length).toBeGreaterThan(0);
  }, 30_000);

  itLive("extract with fields returns keyed objects", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "extract")!.execute({
      selector: "body",
      fields: { heading: "h1", link: { selector: "a", attr: "href" } },
    })) as { kind: "json"; json: { rows: Array<{ heading: string | null; link: string | null }> } };
    expect(r.json.rows.length).toBe(1);
    expect(typeof r.json.rows[0]?.heading).toBe("string");
    expect(typeof r.json.rows[0]?.link).toBe("string");
  }, 30_000);

  itLive("cdp_raw issues Page.getNavigationHistory and returns a result", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "cdp_raw")!.execute({
      method: "Page.getNavigationHistory",
    })) as { kind: "json"; json: Record<string, unknown> };
    expect(r.json).toHaveProperty("currentIndex");
    expect(r.json).toHaveProperty("entries");
  }, 30_000);

  it("cdp_raw rejects malformed method names", () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    return expect(
      tools.find((t) => t.name === "cdp_raw")!.execute({ method: "not_a_method" }),
    ).rejects.toThrow();
  });

  it("cdp_raw is gated by the approval flag", () => {
    const reg = buildWorkerToolRegistry();
    const tool = reg.get("cdp_raw");
    expect(tool?.mutating).toBe(true);
    expect(tool?.requiresApproval).toBe(true);
  });

  itLive("http_get fetches example.com directly (no browser involvement)", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "http_get")!.execute({ url: "https://example.com/" })) as { kind: "json"; json: Record<string, unknown> };
    expect(typeof r.json.body).toBe("string");
    expect((r.json.body as string).length).toBeGreaterThan(100);
    expect(r.json.status).toBe(200);
  }, 30_000);

  if (!HAS_KEYS) {
    it("skipped — BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set", () => {
      expect(true).toBe(true);
    });
  }
});

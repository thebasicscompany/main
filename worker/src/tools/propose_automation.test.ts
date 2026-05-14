import { afterEach, describe, expect, it, vi } from "vitest";
import { propose_automation, setProposeAutomationDeps } from "./propose_automation.js";

afterEach(() => {
  setProposeAutomationDeps(null);
});

function makeCtx() {
  return {
    session: {} as never,
    runId: "run_test",
    workspaceId: "139e7cdc-7060-49c8-a04f-2afffddbd708",
    accountId: "acc_test",
    workspaceRoot: "/tmp",
    publish: vi.fn(async () => undefined),
  } as never;
}

const validSpec = {
  name: "LP welcome SMS",
  goal: "When a new LP signs up, send them a welcome SMS.",
  outputs: [
    { channel: "sms" as const, to: "+19722144223", when: "on_complete" as const },
  ],
  triggers: [{ type: "manual" as const }],
};

describe("propose_automation", () => {
  it("POSTs draft-from-chat with a worker-minted JWT + returns the api response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        automationId: "auto_1",
        automationVersion: 1,
        draftRunId: "run_dry_1",
        previewPollUrl: "/v1/runs/run_dry_1/dry-run-preview",
      }), { status: 201, headers: { "content-type": "application/json" } }),
    );
    setProposeAutomationDeps({
      fetch: fetchMock as never,
      apiBaseUrl: "https://api.test",
      jwtSecret: "test-secret-very-long-please",
    });

    const r = await propose_automation.execute({ spec: validSpec }, makeCtx());
    expect(r.kind).toBe("json");
    const json = (r as { kind: "json"; json: Record<string, unknown> }).json;
    expect(json.ok).toBe(true);
    expect(json.automationId).toBe("auto_1");
    expect(json.draftRunId).toBe("run_dry_1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    const [url, init] = firstCall;
    expect(url).toBe("https://api.test/v1/workspaces/139e7cdc-7060-49c8-a04f-2afffddbd708/automations/draft-from-chat");
    expect(init.headers.Authorization).toMatch(/^Bearer eyJ/);
    const sentBody = JSON.parse(init.body);
    expect(sentBody.draft).toMatchObject({ name: "LP welcome SMS" });
    expect(sentBody.sessionId).toBe("run_test");
    // I.1 — authoring chat fires the dry-run on Opus 4.7.
    expect(sentBody.model).toBe("anthropic/claude-opus-4-7");
  });

  it("forwards draftId on revision iterations", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ automationId: "auto_1", automationVersion: 2, draftRunId: "run_dry_2", previewPollUrl: "/v1/runs/run_dry_2/dry-run-preview" }),
        { status: 200, headers: { "content-type": "application/json" } }),
    );
    setProposeAutomationDeps({ fetch: fetchMock as never, apiBaseUrl: "https://api.test", jwtSecret: "s-long-enough-please-thanks" });
    await propose_automation.execute({ draftId: "11111111-1111-4111-8111-111111111111", spec: validSpec }, makeCtx());
    const init1 = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
    const body = JSON.parse(init1.body);
    expect(body.draftId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("returns structured error on non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "draft_not_found" }), {
        status: 404, headers: { "content-type": "application/json" },
      }),
    );
    setProposeAutomationDeps({ fetch: fetchMock as never, apiBaseUrl: "https://api.test", jwtSecret: "s-long-enough-please-thanks" });

    const r = await propose_automation.execute({ draftId: "11111111-1111-4111-8111-111111111111", spec: validSpec }, makeCtx());
    const json = (r as { json: { ok: boolean; error?: { code: string; status: number } } }).json;
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe("draft_from_chat_failed");
    expect(json.error?.status).toBe(404);
  });

  it("validates input spec via Zod (rejects missing name)", async () => {
    setProposeAutomationDeps({ fetch: vi.fn() as never, apiBaseUrl: "https://api.test", jwtSecret: "s-long-enough-please-thanks" });
    // params.parse runs at the call site; the tool registry's executor
    // parses via def.params before execute. Here we exercise the schema
    // directly.
    expect(() =>
      propose_automation.params.parse({ spec: { goal: "no name" } }),
    ).toThrow();
  });
});

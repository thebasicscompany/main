import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activate_automation,
  activateAutomationApproval,
  setActivateAutomationDeps,
} from "./activate_automation.js";

afterEach(() => {
  setActivateAutomationDeps(null);
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

describe("activate_automation", () => {
  it("approval inspector is required by default (conservative)", () => {
    const d = activateAutomationApproval({ automationId: "11111111-1111-4111-8111-111111111111" });
    expect(d.required).toBe(true);
    expect(d.reason).toMatch(/triggers/i);
    expect(d.expiresInSeconds).toBe(30 * 60);
  });

  it("POSTs /:id/activate with a worker-minted JWT + returns the api response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        automation: { id: "auto_1", status: "active" },
        triggerRegistration: { added: [], removed: [], warnings: [] },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    setActivateAutomationDeps({ fetch: fetchMock as never, apiBaseUrl: "https://api.test", jwtSecret: "s-long-enough-please-thanks" });

    const r = await activate_automation.execute(
      { automationId: "11111111-1111-4111-8111-111111111111" },
      makeCtx(),
    );
    const json = (r as { json: { ok: boolean; automation?: { id: string; status: string } } }).json;
    expect(json.ok).toBe(true);
    expect(json.automation?.status).toBe("active");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    const [url, init] = firstCall;
    expect(url).toBe("https://api.test/v1/automations/11111111-1111-4111-8111-111111111111/activate");
    expect(init.headers.Authorization).toMatch(/^Bearer eyJ/);
  });

  it("returns structured error on 409 (e.g. cannot_activate_archived)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "cannot_activate_archived" }), {
        status: 409, headers: { "content-type": "application/json" },
      }),
    );
    setActivateAutomationDeps({ fetch: fetchMock as never, apiBaseUrl: "https://api.test", jwtSecret: "s-long-enough-please-thanks" });

    const r = await activate_automation.execute(
      { automationId: "11111111-1111-4111-8111-111111111111" },
      makeCtx(),
    );
    const json = (r as { json: { ok: boolean; error?: { code: string; status: number } } }).json;
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe("activate_failed");
    expect(json.error?.status).toBe(409);
  });

  it("validates input via Zod (rejects bad UUID)", () => {
    expect(() =>
      activate_automation.params.parse({ automationId: "not-a-uuid" }),
    ).toThrow();
  });
});

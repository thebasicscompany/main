import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sqsSendMock = vi.fn(async (_cmd: unknown) => ({ MessageId: "mock" }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = sqsSendMock; },
  SendMessageCommand: class { input: unknown; constructor(i: unknown) { this.input = i; } },
}));

interface SqlCall { fragment: string; values: unknown[] }
const sqlCalls: SqlCall[] = [];
const sqlResponses: unknown[][] = [];

const sqlTagFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
  sqlCalls.push({ fragment: strings.join("?"), values });
  return Promise.resolve(sqlResponses.shift() ?? []);
};
// postgres-js sql tag also exposes sql.json(...) — the kicker uses it for inputs.
(sqlTagFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

vi.mock("postgres", () => ({
  default: () => sqlTagFn,
}));

beforeAll(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.DATABASE_URL_POOLER = "postgres://x";
  process.env.RUNS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000/basics-runs.fifo";
});

beforeEach(() => {
  vi.resetModules();
  sqsSendMock.mockClear();
  sqlCalls.length = 0;
  sqlResponses.length = 0;
});

const AID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("cron-kicker handler — D.6 automation path", () => {
  it("happy path: fetches automation + INSERTs cloud_runs + dispatches SQS", async () => {
    sqlResponses.push([{ id: AID, goal: "process new emails", version: 3, archived_at: null, workspace_id: "ws_uuid" }]);
    sqlResponses.push([{ id: "cag_existing" }]);  // ensureAdHocAgent — SELECT hits
    sqlResponses.push([]);  // INSERT cloud_runs
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID,
      workspaceId: "ws_uuid",
      accountId: "acc_uuid",
      goal: "ignored (kicker reads current automation.goal)",
      triggeredBy: "schedule",
    });
    expect(result.runId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.skipped).toBeUndefined();

    // SQL calls: SELECT automations, SELECT cloud_agents (ad-hoc), INSERT cloud_runs.
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0]!.fragment).toContain("FROM public.automations");
    expect(sqlCalls[1]!.fragment).toContain("FROM public.cloud_agents");
    expect(sqlCalls[2]!.fragment).toContain("INSERT INTO public.cloud_runs");

    // SQS dispatch shape.
    expect(sqsSendMock).toHaveBeenCalledOnce();
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string; MessageGroupId: string } };
    expect(sent.input.MessageGroupId).toBe("ws_uuid");
    const body = JSON.parse(sent.input.MessageBody) as Record<string, unknown>;
    expect(body.automationId).toBe(AID);
    expect(body.automationVersion).toBe(3);
    expect(body.triggeredBy).toBe("schedule");
    expect(body.goal).toBe("process new emails");
    expect(body.inputs).toEqual({});
  });

  it("skips archived automation (no INSERT, no SQS)", async () => {
    sqlResponses.push([{ id: AID, goal: "x", version: 1, archived_at: new Date().toISOString(), workspace_id: "ws" }]);
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("archived");
    expect(sqsSendMock).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it("skips missing automation (no INSERT, no SQS)", async () => {
    sqlResponses.push([]);
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not_found");
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("creates ad-hoc cloud_agent when missing", async () => {
    sqlResponses.push([{ id: AID, goal: "g", version: 1, archived_at: null, workspace_id: "ws" }]);
    sqlResponses.push([]);                          // SELECT cloud_agents — empty
    sqlResponses.push([{ id: "cag_newly_created" }]);  // INSERT cloud_agents RETURNING
    sqlResponses.push([]);                          // INSERT cloud_runs
    const { handler } = await import("./handler.js");
    const result = await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
    });
    expect(result.runId).toBeDefined();
    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls[2]!.fragment).toContain("INSERT INTO public.cloud_agents");
  });

  it("substitutes vars in the goal before SQS dispatch", async () => {
    sqlResponses.push([{ id: AID, goal: "review {VIDEO_ID}", version: 1, archived_at: null, workspace_id: "ws" }]);
    sqlResponses.push([{ id: "cag" }]);
    sqlResponses.push([]);
    const { handler } = await import("./handler.js");
    await handler({
      automationId: AID, workspaceId: "ws", accountId: "acc",
      vars: { VIDEO_ID: "abc123" },
    });
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageBody: string } };
    const body = JSON.parse(sent.input.MessageBody) as Record<string, unknown>;
    expect(body.goal).toBe("review abc123");
  });
});

describe("cron-kicker handler — legacy cloud_agents path (unchanged)", () => {
  it("dispatches when given cloudAgentId + goal", async () => {
    sqlResponses.push([]);  // INSERT cloud_runs
    const { handler } = await import("./handler.js");
    const result = await handler({
      cloudAgentId: "cag_legacy",
      workspaceId: "ws",
      accountId: "acc",
      goal: "legacy goal",
    });
    expect(result.runId).toBeDefined();
    expect(sqsSendMock).toHaveBeenCalledOnce();
    const sent = sqsSendMock.mock.calls[0]![0] as { input: { MessageGroupId: string; MessageBody: string } };
    expect(sent.input.MessageGroupId).toBe("ws:default");
    expect(JSON.parse(sent.input.MessageBody).goal).toBe("legacy goal");
  });
});

describe("cron-kicker handler — validation", () => {
  it("throws if neither cloudAgentId nor automationId set", async () => {
    const { handler } = await import("./handler.js");
    await expect(
      handler({ workspaceId: "ws", accountId: "acc", goal: "no id" }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("throws if workspaceId missing", async () => {
    const { handler } = await import("./handler.js");
    await expect(
      handler({ automationId: AID } as unknown as Parameters<typeof handler>[0]),
    ).rejects.toThrow(/workspaceId\/accountId/);
  });
});

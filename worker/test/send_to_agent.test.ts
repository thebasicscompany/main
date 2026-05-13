// BUILD-LOOP E.3 — send_to_agent + agent_inboxes flow tests.

import { describe, expect, it } from "vitest";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";
import { buildWorkerToolRegistry, type WorkerToolContext } from "../src/tools/index.js";
import {
  CrossWorkspaceMessageError,
  InMemoryInboxesRepo,
} from "../src/inboxes-repo.js";
import type { CdpSession } from "@basics/harness";

const ws = "ws-e03";
const RESEARCH = "lane-research";
const OPS = "lane-ops";

const ctxFor = (laneId: string | null, repo: InMemoryInboxesRepo, captured?: Array<{ type: string; payload: Record<string, unknown> }>): WorkerToolContext => ({
  session: undefined as unknown as CdpSession,
  runId: "00000000-0000-0000-0000-000000000e03",
  workspaceId: ws,
  accountId: "00000000-0000-0000-0000-000000000e03",
  workspaceRoot: "/tmp",
  publish: (e) => { captured?.push(e); },
  inboxesRepo: repo,
  laneId,
});

describe("InMemoryInboxesRepo — send / listUnreadFor / markRead", () => {
  it("send + listUnreadFor returns the message for the recipient lane", async () => {
    const repo = new InMemoryInboxesRepo();
    await repo.send({
      toWorkspaceId: ws,
      toLaneId: OPS,
      fromWorkspaceId: ws,
      fromLaneId: RESEARCH,
      body: { hello: "ops" },
    });
    const unread = await repo.listUnreadFor({ workspaceId: ws, laneId: OPS });
    expect(unread.length).toBe(1);
    expect(unread[0]?.body).toEqual({ hello: "ops" });
    expect(unread[0]?.fromLaneId).toBe(RESEARCH);
  });

  it("does not bleed across lanes (research lane sees nothing in ops's inbox)", async () => {
    const repo = new InMemoryInboxesRepo();
    await repo.send({ toWorkspaceId: ws, toLaneId: OPS, fromWorkspaceId: ws, fromLaneId: RESEARCH, body: { x: 1 } });
    expect((await repo.listUnreadFor({ workspaceId: ws, laneId: RESEARCH })).length).toBe(0);
  });

  it("does not bleed across workspaces", async () => {
    const repo = new InMemoryInboxesRepo();
    await repo.send({ toWorkspaceId: ws, toLaneId: OPS, fromWorkspaceId: ws, fromLaneId: RESEARCH, body: { x: 1 } });
    expect((await repo.listUnreadFor({ workspaceId: "ws-other", laneId: OPS })).length).toBe(0);
  });

  it("markRead removes the message from listUnread", async () => {
    const repo = new InMemoryInboxesRepo();
    const msg = await repo.send({ toWorkspaceId: ws, toLaneId: OPS, fromWorkspaceId: ws, body: {} });
    expect((await repo.listUnreadFor({ workspaceId: ws, laneId: OPS })).length).toBe(1);
    await repo.markRead(msg.id);
    expect((await repo.listUnreadFor({ workspaceId: ws, laneId: OPS })).length).toBe(0);
  });

  it("rejects cross-workspace send (intra-workspace only per §10.3)", async () => {
    const repo = new InMemoryInboxesRepo();
    await expect(
      repo.send({
        toWorkspaceId: ws,
        toLaneId: OPS,
        fromWorkspaceId: "ws-attacker",
        fromLaneId: null,
        body: {},
      }),
    ).rejects.toThrow(CrossWorkspaceMessageError);
  });

  it("ordering: oldest unread first", async () => {
    const repo = new InMemoryInboxesRepo();
    await repo.send({ toWorkspaceId: ws, toLaneId: OPS, fromWorkspaceId: ws, body: { n: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    await repo.send({ toWorkspaceId: ws, toLaneId: OPS, fromWorkspaceId: ws, body: { n: 2 } });
    const unread = await repo.listUnreadFor({ workspaceId: ws, laneId: OPS });
    expect(unread.map((m) => (m.body as { n: number }).n)).toEqual([1, 2]);
  });

  it("limit caps the result", async () => {
    const repo = new InMemoryInboxesRepo();
    for (let i = 0; i < 5; i++) {
      await repo.send({ toWorkspaceId: ws, toLaneId: OPS, fromWorkspaceId: ws, body: { i } });
    }
    expect((await repo.listUnreadFor({ workspaceId: ws, laneId: OPS, limit: 3 })).length).toBe(3);
  });
});

describe("send_to_agent tool", () => {
  it("research → ops: tool inserts into inbox + emits agent_message event", async () => {
    const repo = new InMemoryInboxesRepo();
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = ctxFor(RESEARCH, repo, captured);
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const r = (await tools.find((t) => t.name === "send_to_agent")!.execute({
      toLaneId: OPS,
      body: { topic: "stale dashboard", priority: "low" },
    })) as { kind: "json"; json: { messageId: string; sentAt: string } };

    expect(r.json.messageId).toBeDefined();
    expect(captured.map((e) => e.type)).toEqual(["agent_message"]);
    expect(captured[0]?.payload.from).toBe(RESEARCH);
    expect(captured[0]?.payload.to).toBe(OPS);

    // ops's lane reads its inbox and sees the message.
    const unread = await repo.listUnreadFor({ workspaceId: ws, laneId: OPS });
    expect(unread.length).toBe(1);
    expect(unread[0]?.body).toEqual({ topic: "stale dashboard", priority: "low" });
  });

  it("send without toLaneId targets the workspace's default inbox", async () => {
    const repo = new InMemoryInboxesRepo();
    const ctx = ctxFor(RESEARCH, repo);
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "send_to_agent")!.execute({ body: { hi: "all" } });
    expect((await repo.listUnreadFor({ workspaceId: ws, laneId: null })).length).toBe(1);
  });

  it("throws send_to_agent_unavailable when ctx.inboxesRepo is missing", async () => {
    const ctx = { ...ctxFor(RESEARCH, new InMemoryInboxesRepo()), inboxesRepo: undefined };
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await expect(
      tools.find((t) => t.name === "send_to_agent")!.execute({ body: {} }),
    ).rejects.toThrow(/send_to_agent_unavailable/);
  });

  it("registry: mutating, NOT approval-gated, cost: low; size 39", () => {
    const reg = buildWorkerToolRegistry();
    const t = reg.get("send_to_agent");
    expect(t?.mutating).toBe(true);
    expect(t?.requiresApproval).toBe(false);
    expect(t?.cost).toBe("low");
    expect(reg.size).toBe(39);
  });
});

describe("E.3 verify — research → ops within 30s (no real polling needed in unit test)", () => {
  it("send + listUnreadFor sequence proves the message is visible to ops's next tick", async () => {
    const repo = new InMemoryInboxesRepo();
    const ctx = ctxFor(RESEARCH, repo);
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    await tools.find((t) => t.name === "send_to_agent")!.execute({
      toLaneId: OPS,
      body: { findings: ["dashboard CSS regressed", "selectors still valid"] },
    });
    // ops's worker tick:
    const unread = await repo.listUnreadFor({ workspaceId: ws, laneId: OPS });
    expect(unread.length).toBe(1);
    const body = unread[0]?.body as { findings: string[] };
    expect(body.findings).toContain("dashboard CSS regressed");
    expect(unread[0]?.readAt).toBeNull();

    // After processing, ops marks read.
    await repo.markRead(unread[0]!.id);
    expect((await repo.listUnreadFor({ workspaceId: ws, laneId: OPS })).length).toBe(0);
  });
});

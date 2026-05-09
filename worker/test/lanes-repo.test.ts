// BUILD-LOOP E.1 — agent_lanes CRUD tests.
// Verify spec equivalent: create lanes 'ops' and 'research'; list returns
// both; group keys differ; rename / pause / delete behaviors.

import { describe, expect, it } from "vitest";
import {
  InMemoryLanesRepo,
  LaneNameTakenError,
  LaneNotFoundError,
  laneGroupKey,
} from "../src/lanes-repo.js";

const ws = "ws-e01";

describe("InMemoryLanesRepo — create + list", () => {
  it("creates 'ops' and 'research', lists both in insertion order", async () => {
    const repo = new InMemoryLanesRepo();
    const ops = await repo.create({ workspaceId: ws, name: "ops" });
    const research = await repo.create({ workspaceId: ws, name: "research" });
    expect(ops.id).not.toBe(research.id);
    expect(ops.status).toBe("active");
    const list = await repo.list(ws);
    expect(list.map((l) => l.name)).toEqual(["ops", "research"]);
  });

  it("rejects duplicate names within a workspace", async () => {
    const repo = new InMemoryLanesRepo();
    await repo.create({ workspaceId: ws, name: "ops" });
    await expect(repo.create({ workspaceId: ws, name: "ops" })).rejects.toThrow(
      LaneNameTakenError,
    );
  });

  it("allows the same name in different workspaces", async () => {
    const repo = new InMemoryLanesRepo();
    await repo.create({ workspaceId: "ws-a", name: "ops" });
    await repo.create({ workspaceId: "ws-b", name: "ops" });
    expect((await repo.list("ws-a")).length).toBe(1);
    expect((await repo.list("ws-b")).length).toBe(1);
  });
});

describe("InMemoryLanesRepo — get + update + delete", () => {
  it("get returns null for unknown id or wrong workspace", async () => {
    const repo = new InMemoryLanesRepo();
    const ops = await repo.create({ workspaceId: ws, name: "ops" });
    expect(await repo.get(ws, ops.id)).not.toBeNull();
    expect(await repo.get(ws, "no-such-id")).toBeNull();
    expect(await repo.get("ws-other", ops.id)).toBeNull();
  });

  it("update applies partial changes", async () => {
    const repo = new InMemoryLanesRepo();
    const ops = await repo.create({ workspaceId: ws, name: "ops" });
    const updated = await repo.update({
      id: ops.id,
      workspaceId: ws,
      defaultModel: "claude-sonnet-4-6",
      status: "paused",
    });
    expect(updated.defaultModel).toBe("claude-sonnet-4-6");
    expect(updated.status).toBe("paused");
    expect(updated.name).toBe("ops");
  });

  it("update on unknown id throws LaneNotFoundError", async () => {
    const repo = new InMemoryLanesRepo();
    await expect(
      repo.update({ id: "no-such-id", workspaceId: ws, status: "paused" }),
    ).rejects.toThrow(LaneNotFoundError);
  });

  it("delete removes the lane and is idempotent only via error on second call", async () => {
    const repo = new InMemoryLanesRepo();
    const ops = await repo.create({ workspaceId: ws, name: "ops" });
    await repo.delete(ws, ops.id);
    expect(await repo.get(ws, ops.id)).toBeNull();
    await expect(repo.delete(ws, ops.id)).rejects.toThrow(LaneNotFoundError);
  });
});

describe("laneGroupKey — SQS FIFO MessageGroupId composition", () => {
  it("ws + lane id → '<ws>:<lane>'", () => {
    expect(laneGroupKey("ws-1", "lane-A")).toBe("ws-1:lane-A");
  });

  it("null/undefined lane → '<ws>:default' (single-lane workspace path)", () => {
    expect(laneGroupKey("ws-1", null)).toBe("ws-1:default");
    expect(laneGroupKey("ws-1", undefined)).toBe("ws-1:default");
  });

  it("two lanes get distinct group keys (so SQS parallelizes them)", () => {
    expect(laneGroupKey("ws-1", "ops")).not.toBe(laneGroupKey("ws-1", "research"));
  });
});

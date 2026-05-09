// BUILD-LOOP D.4 — skill decay nightly job tests.
// Verify spec: backdate a skill row; run job; confirm row demoted.

import { describe, expect, it } from "vitest";
import { InMemorySkillDecayJob } from "../src/skill-decay.js";

const ws = "ws-d04";
const NOW = new Date("2026-05-09T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("InMemorySkillDecayJob — demotion", () => {
  it("demotes a row whose lastEditedAt is older than 30 days", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({
      id: "stale",
      workspaceId: ws,
      lastEditedAt: new Date(NOW.getTime() - 31 * DAY),
    });
    const r = await job.runOnce({ workspaceId: ws, now: NOW });
    expect(r.demoted).toBe(1);
    expect(job.rows[0]?.active).toBe(false);
  });

  it("does NOT demote a fresh row (lastEditedAt 5 days ago)", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({
      id: "fresh",
      workspaceId: ws,
      lastEditedAt: new Date(NOW.getTime() - 5 * DAY),
    });
    const r = await job.runOnce({ workspaceId: ws, now: NOW });
    expect(r.demoted).toBe(0);
    expect(job.rows[0]?.active).toBe(true);
  });

  it("falls back to createdAt when lastEditedAt is null", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({
      id: "null-edited",
      workspaceId: ws,
      lastEditedAt: null,
      createdAt: new Date(NOW.getTime() - 45 * DAY),
    });
    const r = await job.runOnce({ workspaceId: ws, now: NOW });
    expect(r.demoted).toBe(1);
  });

  it("skips already-inactive rows", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({ id: "i", workspaceId: ws, active: false, lastEditedAt: new Date(NOW.getTime() - 90 * DAY) });
    expect((await job.runOnce({ workspaceId: ws, now: NOW })).demoted).toBe(0);
  });

  it("skips pending_review rows (not yet approved)", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({ id: "p", workspaceId: ws, pendingReview: true, lastEditedAt: new Date(NOW.getTime() - 60 * DAY) });
    expect((await job.runOnce({ workspaceId: ws, now: NOW })).demoted).toBe(0);
  });

  it("workspace_id filter scopes the job", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({ id: "a", workspaceId: "ws-x", lastEditedAt: new Date(NOW.getTime() - 60 * DAY) });
    job.add({ id: "b", workspaceId: "ws-y", lastEditedAt: new Date(NOW.getTime() - 60 * DAY) });
    const r = await job.runOnce({ workspaceId: "ws-x", now: NOW });
    expect(r.demoted).toBe(1);
    expect(job.rows.find((r) => r.id === "a")?.active).toBe(false);
    expect(job.rows.find((r) => r.id === "b")?.active).toBe(true);
  });

  it("global run (no workspace filter) demotes across workspaces", async () => {
    const job = new InMemorySkillDecayJob();
    job.add({ id: "a", workspaceId: "ws-x", lastEditedAt: new Date(NOW.getTime() - 60 * DAY) });
    job.add({ id: "b", workspaceId: "ws-y", lastEditedAt: new Date(NOW.getTime() - 60 * DAY) });
    const r = await job.runOnce({ now: NOW });
    expect(r.demoted).toBe(2);
  });

  it("custom unverifiedAfterDays threshold", async () => {
    const job = new InMemorySkillDecayJob({ unverifiedAfterDays: 7 });
    job.add({
      id: "x",
      workspaceId: ws,
      lastEditedAt: new Date(NOW.getTime() - 8 * DAY),
    });
    expect((await job.runOnce({ workspaceId: ws, now: NOW })).demoted).toBe(1);
  });

  it("BUILD-LOOP D.4 verify: backdate row, run job, confirm demoted", async () => {
    const job = new InMemorySkillDecayJob();
    // Spec scenario: skill written 35 days ago, never re-verified.
    job.add({
      id: "spec",
      workspaceId: ws,
      lastEditedAt: new Date(NOW.getTime() - 35 * DAY),
    });
    expect(job.rows[0]?.active).toBe(true);
    const r = await job.runOnce({ workspaceId: ws, now: NOW });
    expect(r.demoted).toBe(1);
    expect(job.rows[0]?.active).toBe(false);
  });
});

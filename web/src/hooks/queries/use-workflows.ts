"use client";

import { useQuery } from "@tanstack/react-query";

import { mockRuns } from "@/mocks/runs";
import { findWorkflow, mockWorkflows } from "@/mocks/workflows";
import type { Run, Workflow, WorkflowSummary } from "@/types/runs";

const COMPLETED_STATUSES = new Set(["verified", "unverified", "completed", "failed"]);
const SUCCESS_STATUSES = new Set(["verified", "completed"]);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: async (): Promise<WorkflowSummary[]> => {
      await delay();
      return mockWorkflows.map((wf) => summarize(wf, mockRuns));
    },
  });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: ["workflow", id],
    queryFn: async (): Promise<{ workflow: WorkflowSummary; recentRuns: Run[] } | null> => {
      await delay();
      if (!id) return null;
      const wf = findWorkflow(id);
      if (!wf) return null;
      const recentRuns = mockRuns
        .filter((r) => r.workflowId === id)
        .slice()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10);
      return { workflow: summarize(wf, mockRuns), recentRuns };
    },
    enabled: Boolean(id),
  });
}

function summarize(wf: Workflow, runs: Run[]): WorkflowSummary {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const wfRuns = runs.filter((r) => r.workflowId === wf.id);
  const recent = wfRuns.filter((r) => new Date(r.startedAt).getTime() >= cutoff);
  const completed = recent.filter((r) => COMPLETED_STATUSES.has(r.status));
  const successful = completed.filter((r) => SUCCESS_STATUSES.has(r.status));
  const successRate = completed.length === 0 ? null : successful.length / completed.length;
  const lastRun = wfRuns
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return {
    ...wf,
    successRate,
    runsLast7d: recent.length,
    lastRun: lastRun
      ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt }
      : undefined,
  };
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

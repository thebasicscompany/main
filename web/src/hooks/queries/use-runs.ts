"use client";

import { useQuery } from "@tanstack/react-query";

import { findRun, mockRuns } from "@/mocks/runs";
import { detailedRunChecks, detailedRunSteps, synthesizeSteps } from "@/mocks/run-steps";
import type { CheckResult, Run, RunStep, RunsFilter } from "@/types/runs";

/**
 * Mock-backed for now. When `api.trybasics.ai/v1/runtime/runs` is live,
 * swap the queryFn body for a fetch — page components don't change.
 */
export function useRuns(filter: RunsFilter = {}) {
  return useQuery({
    queryKey: ["runs", filter],
    queryFn: async (): Promise<Run[]> => {
      await delay();
      return mockRuns.filter((r) => matches(r, filter));
    },
  });
}

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: async (): Promise<Run | null> => {
      await delay();
      if (!runId) return null;
      return findRun(runId) ?? null;
    },
    enabled: Boolean(runId),
  });
}

export function useRunSteps(runId: string | undefined) {
  return useQuery({
    queryKey: ["run-steps", runId],
    queryFn: async (): Promise<RunStep[]> => {
      await delay();
      if (!runId) return [];
      const cached = detailedRunSteps[runId];
      if (cached) return cached;
      const run = findRun(runId);
      return run ? synthesizeSteps(runId, run.stepCount, run.status) : [];
    },
    enabled: Boolean(runId),
  });
}

export function useRunChecks(runId: string | undefined) {
  return useQuery({
    queryKey: ["run-checks", runId],
    queryFn: async (): Promise<CheckResult[]> => {
      await delay();
      if (!runId) return [];
      return detailedRunChecks[runId] ?? [];
    },
    enabled: Boolean(runId),
  });
}

function matches(run: Run, filter: RunsFilter): boolean {
  if (filter.status && filter.status !== "all" && run.status !== filter.status) return false;
  if (filter.workflowId && run.workflowId !== filter.workflowId) return false;
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    if (!run.id.toLowerCase().includes(needle) && !run.workflowName.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

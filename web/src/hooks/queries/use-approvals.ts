"use client";

import { useQuery } from "@tanstack/react-query";

import { mockApprovals } from "@/mocks/approvals";
import type { Approval, ApprovalStatus } from "@/types/runs";

export function useApprovals(filter: { status?: ApprovalStatus | "all" } = {}) {
  return useQuery({
    queryKey: ["approvals", filter],
    queryFn: async (): Promise<Approval[]> => {
      await delay();
      return mockApprovals.filter((a) => {
        if (filter.status && filter.status !== "all" && a.status !== filter.status) return false;
        return true;
      });
    },
  });
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

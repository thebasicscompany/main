"use client";

import { useQuery } from "@tanstack/react-query";

import { mockWorkspaceMembers, mockWorkspaceSummary } from "@/mocks/settings";
import type { WorkspaceMember, WorkspaceSummary } from "@/types/settings";

export type WorkspaceSettingsPayload = {
  workspace: WorkspaceSummary;
  members: WorkspaceMember[];
};

export function useSettingsWorkspace() {
  return useQuery({
    queryKey: ["settings", "workspace"],
    queryFn: async (): Promise<WorkspaceSettingsPayload> => {
      await delay();
      return {
        workspace: mockWorkspaceSummary,
        members: mockWorkspaceMembers,
      };
    },
  });
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { mockIntegrations } from "@/mocks/settings";
import type { Integration } from "@/types/settings";

export function useSettingsIntegrations() {
  return useQuery({
    queryKey: ["settings", "integrations"],
    queryFn: async (): Promise<Integration[]> => {
      await delay();
      return mockIntegrations;
    },
  });
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

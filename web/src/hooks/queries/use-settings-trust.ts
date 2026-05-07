"use client";

import { useQuery } from "@tanstack/react-query";

import { mockTrustGrants } from "@/mocks/settings";
import type { TrustGrant } from "@/types/settings";

export function useSettingsTrustGrants() {
  return useQuery({
    queryKey: ["settings", "trust"],
    queryFn: async (): Promise<TrustGrant[]> => {
      await delay();
      return mockTrustGrants;
    },
  });
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { mockApiTokens, mockWebhooks } from "@/mocks/settings";
import type { ApiToken, WebhookEndpoint } from "@/types/settings";

export type DeveloperSettingsPayload = {
  tokens: ApiToken[];
  webhooks: WebhookEndpoint[];
};

export function useSettingsDeveloper() {
  return useQuery({
    queryKey: ["settings", "developer"],
    queryFn: async (): Promise<DeveloperSettingsPayload> => {
      await delay();
      return {
        tokens: mockApiTokens,
        webhooks: mockWebhooks,
      };
    },
  });
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

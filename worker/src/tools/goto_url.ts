import { defineTool } from "@basics/shared";
import { goto_url as harnessGotoUrl } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";
import { loadStorageStateForUrl } from "../browser-sites/loader.js";

export const goto_url = defineTool({
  name: "goto_url",
  description:
    "Navigate the active tab to a URL. Returns the navigation result (frame id, etc.).",
  params: z.object({
    url: z.string().url(),
  }),
  // Navigation is information-class for approvals — it doesn't write
  // tenant data. Click / type / fill_input are the mutating ones.
  mutating: false,
  cost: "low",
  execute: async ({ url }, ctx: WorkerToolContext) => {
    // E.2 — look up a saved browser-session storageState for the URL's
    // host. If one exists, we'd preload it into the Browserbase session
    // (cookies + localStorage) so logged-in sites work without re-auth.
    // The actual application is gated on browser-harness exposing a
    // session-create `storageState` option; until that lands we emit a
    // `browser_session_storage_state_not_supported` warning so the live
    // verify can confirm the loader is wired even though the bytes
    // aren't yet getting applied. Real cookie injection ships in E.3.
    if (ctx.browserSites) {
      const state = await loadStorageStateForUrl(
        ctx.browserSites.sql,
        ctx.browserSites.workspaceId,
        url,
      );
      if (state) {
        await ctx.publish({
          type: "browser_session_storage_state_not_supported",
          payload: {
            host: state.host,
            url,
            reason:
              "harness daemon session-create does not yet accept a storageState blob; cookies + localStorage will not be preloaded for this run",
          },
        });
      }
    }
    const result = await harnessGotoUrl(ctx.session, url);
    // Runner owns the tool_call_start/end timeline.
    return { kind: "json", json: result };
  },
});

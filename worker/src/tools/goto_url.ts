import { defineTool } from "@basics/shared";
import { goto_url as harnessGotoUrl, js as harnessJs } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";
import {
  loadStorageStateForUrl,
  markBrowserSiteVerified,
} from "../browser-sites/loader.js";
import { detectSignInWall } from "../browser-sites/detector.js";

/**
 * Pull a chunk of innerText off the active page after a navigation, capped
 * so we don't haul 5 MB of HTML back across CDP. The detector only scans
 * the first 64 KB anyway. Failure is non-fatal — null tells the detector
 * to skip the text branch and rely on URL + nothing-else.
 */
async function readPageTextSafely(
  session: WorkerToolContext["session"],
): Promise<string | null> {
  try {
    const raw = await harnessJs(
      session,
      "(document.body && document.body.innerText || '').slice(0, 65536)",
    );
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

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
    // E.2 / E.3 — look up a saved browser-session storageState for the
    // URL's host. The bytes aren't yet getting applied to the
    // Browserbase session (gated on harness daemon support), but we
    // surface a `browser_session_storage_state_not_supported` warning
    // so live verify can confirm the loader is wired. After navigation
    // we run the E.3 sign-in-wall detector and emit one of three
    // outcomes:
    //   - gated + no saved state → browser_login_required + structured error
    //   - gated +    saved state → browser_session_expired (state stale)
    //   - !gated +   saved state → markBrowserSiteVerified (bump verified_at)
    let savedState: Awaited<ReturnType<typeof loadStorageStateForUrl>> = null;
    if (ctx.browserSites) {
      savedState = await loadStorageStateForUrl(
        ctx.browserSites.sql,
        ctx.browserSites.workspaceId,
        url,
      );
      if (savedState) {
        await ctx.publish({
          type: "browser_session_storage_state_not_supported",
          payload: {
            host: savedState.host,
            url,
            reason:
              "harness daemon session-create does not yet accept a storageState blob; cookies + localStorage will not be preloaded for this run",
          },
        });
      }
    }

    const result = await harnessGotoUrl(ctx.session, url);

    if (ctx.browserSites) {
      const pageText = await readPageTextSafely(ctx.session);
      const detection = detectSignInWall(pageText, url);
      const host = savedState?.host ?? hostFromUrlSafely(url);
      if (detection.gated) {
        if (!savedState) {
          await ctx.publish({
            type: "browser_login_required",
            payload: {
              kind: "browser_login_required",
              host,
              current_url: url,
              signal: detection.signal ?? null,
            },
          });
          return {
            kind: "json" as const,
            json: {
              ok: false,
              error: {
                code: "browser_login_required",
                host,
                current_url: url,
                signal: detection.signal,
              },
            },
          };
        }
        await ctx.publish({
          type: "browser_session_expired",
          payload: {
            kind: "browser_session_expired",
            host: savedState.host,
            current_url: url,
            signal: detection.signal ?? null,
            reason: "sign_in_wall_after_state_applied",
          },
        });
      } else if (savedState && ctx.browserSites) {
        // Best-effort bump of last_verified_at — confirms the saved
        // state is still valid against the live site.
        await markBrowserSiteVerified(
          ctx.browserSites.sql,
          ctx.browserSites.workspaceId,
          savedState.host,
        );
      }
    }

    // Runner owns the tool_call_start/end timeline.
    return { kind: "json", json: result };
  },
});

function hostFromUrlSafely(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

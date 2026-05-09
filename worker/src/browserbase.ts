// Minimal Browserbase session lifecycle helpers for the worker.
// G.2 — adds Context attach (cookies / state from workspaces.browserbase_profile_id)
// and live-view URL fetch so the operator can iframe the agent's browser.

interface CreateSessionOptions {
  apiKey: string;
  projectId: string;
  workspaceId: string;
  runId: string;
  /** Browserbase Context id — attaches cookies + state from a prior sync. */
  contextId?: string;
  timeoutMs?: number;
}

export interface BrowserbaseSession {
  sessionId: string;
  cdpWsUrl: string;
  /** Browserbase live-view URL (operator-visible iframe). */
  liveViewUrl?: string;
}

export async function createBrowserbaseSession(
  opts: CreateSessionOptions,
): Promise<BrowserbaseSession> {
  const browserSettings: Record<string, unknown> = {
    timeout: opts.timeoutMs ?? 30 * 60_000,
  };
  if (opts.contextId) {
    // `persist: true` writes any cookies/state changes back to the Context
    // when the session ends — so subsequent runs see logins captured this run.
    browserSettings.context = { id: opts.contextId, persist: true };
  }
  const resp = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      "X-BB-API-Key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: opts.projectId,
      browserSettings,
      userMetadata: {
        workspace_id: opts.workspaceId,
        run_id: opts.runId,
        source: "basics_worker",
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Browserbase create failed (${resp.status}): ${await resp.text()}`,
    );
  }
  const created = (await resp.json()) as { id: string; connectUrl: string };

  // Best-effort live-view fetch. The /debug endpoint returns a
  // debuggerFullscreenUrl that's the operator-shareable live view.
  let liveViewUrl: string | undefined;
  try {
    const dbg = await fetch(
      `https://api.browserbase.com/v1/sessions/${created.id}/debug`,
      { headers: { "X-BB-API-Key": opts.apiKey } },
    );
    if (dbg.ok) {
      const j = (await dbg.json()) as {
        debuggerFullscreenUrl?: string;
        debuggerUrl?: string;
      };
      liveViewUrl = j.debuggerFullscreenUrl ?? j.debuggerUrl;
    }
  } catch {
    // ignore — liveUrl is observability nice-to-have, not run-critical.
  }

  return { sessionId: created.id, cdpWsUrl: created.connectUrl, liveViewUrl };
}

export async function stopBrowserbaseSession(
  apiKey: string,
  projectId: string,
  sessionId: string,
): Promise<void> {
  await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
    method: "POST",
    headers: {
      "X-BB-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "REQUEST_RELEASE", projectId }),
  });
}

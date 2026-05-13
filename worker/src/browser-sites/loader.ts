// E.2 — Per-workspace saved-browser-session loader.
//
// `workspace_browser_sites` (migration 0025) stores cookies + localStorage
// (the Playwright `storageState` blob) keyed by (workspace_id, host). At
// run boot we attach a SQL handle + workspace_id to ctx; on every navigation
// the harness integration looks up the URL's host and — if a state exists —
// applies it before the page loads, so logged-in flows (LinkedIn, Jira,
// internal SaaS) work without each agent run hitting a sign-in wall.
//
// Host extraction is registrable-domain-style — `https://www.linkedin.com/in/foo`
// and `https://linkedin.com/` both resolve to `linkedin.com`. Custom
// subdomain hosts (`jira.acme.com`) match literally so per-app credentials
// don't collide.

import type postgres from "postgres";

export interface BrowserSiteRow {
  host: string;
  storageState: unknown;
}

/**
 * Lower-case, strip a leading `www.`, drop port and trailing dot. Throws on
 * URLs the WHATWG parser rejects. Callers should swallow the throw; an
 * invalid URL means "no saved state" — never block navigation.
 */
export function extractHost(rawUrl: string): string {
  const u = new URL(rawUrl);
  let host = u.hostname.toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

/**
 * SELECT `workspace_browser_sites` by (workspace_id, host) for the URL's
 * host. Returns `null` when no row exists, when the URL is unparseable, or
 * on read error — never throws. The host on the returned row may differ
 * from the URL's literal host because of www-stripping; callers that want
 * to update `last_verified_at` should pass that host back to
 * `markBrowserSiteVerified`.
 */
export async function loadStorageStateForUrl(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  rawUrl: string,
): Promise<BrowserSiteRow | null> {
  let host: string;
  try {
    host = extractHost(rawUrl);
  } catch {
    return null;
  }

  try {
    const rows = await sql<Array<{ host: string; storage_state_json: unknown }>>`
      SELECT host, storage_state_json
        FROM public.workspace_browser_sites
       WHERE workspace_id = ${workspaceId}
         AND host = ${host}
         AND expires_at > now()
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { host: row.host, storageState: row.storage_state_json };
  } catch (err) {
    console.error(
      "browser-sites/loader: SELECT failed; continuing without saved state",
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Bump `last_verified_at` after a navigation that did NOT hit a sign-in
 * wall — confirms the saved state is still valid against the live site.
 * Best-effort; logs and continues on failure.
 */
export async function markBrowserSiteVerified(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  host: string,
): Promise<void> {
  try {
    await sql`
      UPDATE public.workspace_browser_sites
         SET last_verified_at = now()
       WHERE workspace_id = ${workspaceId}
         AND host = ${host}
    `;
  } catch (err) {
    console.error(
      "browser-sites/loader: UPDATE last_verified_at failed",
      (err as Error).message,
    );
  }
}

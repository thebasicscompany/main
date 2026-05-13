// B.3 — Resolve the set of ACTIVE Composio connected accounts for a
// workspace, keyed by toolkit slug, at session boot.
//
// Composio's connected-accounts API is keyed by `user_id`. In this
// codebase the convention (api/src/routes/composio.ts, managedAssistantRunner.ts)
// is `composioUserId = account_id || workspace_id`. The resolver follows
// that convention.
//
// Errors (Composio API down, missing API key, network blip) are caught
// and converted to an empty map — the tools downstream return
// `no_connection` errors instead of crashing the run.

import {
  ComposioClient,
  ComposioUnavailableError,
  type ComposioConnectedAccount,
} from "@basics/shared";

export type AccountsByToolkit = Map<string, ComposioConnectedAccount>;

export interface ResolveDeps {
  /** Test seam. In production a real ComposioClient is constructed lazily. */
  client?: Pick<ComposioClient, "listConnectedAccounts">;
}

/**
 * The composio user_id for this run. The plugin passes ctx.accountId
 * to match the convention used by the API service routes.
 */
export async function resolveConnectedAccounts(
  composioUserId: string,
  deps: ResolveDeps = {},
): Promise<AccountsByToolkit> {
  const result: AccountsByToolkit = new Map();
  let client: Pick<ComposioClient, "listConnectedAccounts">;
  try {
    client = deps.client ?? new ComposioClient();
  } catch (err) {
    if (err instanceof ComposioUnavailableError) {
      // No API key wired — treat as graceful degradation.
      return result;
    }
    throw err;
  }

  let accounts: ComposioConnectedAccount[];
  try {
    accounts = await client.listConnectedAccounts(composioUserId);
  } catch (err) {
    // Composio API failure: log and return empty so tools fail soft.
    // Log only the HTTP status (when available) — the full error message
    // can echo the request URL which includes the user_ids query param,
    // and we don't want account_id leaking into worker logs.
    const status = (err as { status?: number }).status;
    console.error(
      `composio.resolveConnectedAccounts: listConnectedAccounts failed${status ? ` (status=${status})` : ""}`,
    );
    return result;
  }

  for (const acc of accounts) {
    if ((acc.status ?? "").toUpperCase() !== "ACTIVE") continue;
    const slug = acc.toolkit?.slug;
    if (!slug) continue;
    // First ACTIVE account per toolkit wins. Composio sometimes returns
    // multiple historical accounts for the same toolkit; the agent only
    // needs one to invoke a tool, so dedup on the toolkit slug.
    if (!result.has(slug)) result.set(slug, acc);
  }
  return result;
}

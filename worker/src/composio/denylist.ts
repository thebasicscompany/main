// B.8 — Per-workspace mutating-action denylist for composio_call.
//
// Default patterns (auto-applied unless workspace opts out):
//   /_DELETE_/  /_REMOVE_/  /_DROP_/  /_PURGE_/  /_WIPE_/
//
// Per-workspace overrides live in `workspaces.agent_settings`:
//   - composio_denylist:          string[]   — extra patterns (regex source)
//   - composio_denylist_disabled: boolean    — opt out of defaults
//   - composio_denylist_allow:    string[]   — exact slugs that bypass defaults
//
// Eval order:
//   1) If toolSlug is in `_allow`, ALLOW (no further checks).
//   2) Default patterns (unless disabled) — first match → DENY.
//   3) Workspace custom patterns — first match → DENY.
//   4) Otherwise ALLOW.

import type postgres from "postgres";

export const DEFAULT_DENYLIST: ReadonlyArray<RegExp> = [
  /_DELETE_/,
  /_REMOVE_/,
  /_DROP_/,
  /_PURGE_/,
  /_WIPE_/,
];

export interface WorkspaceComposioPolicy {
  composio_denylist?: string[];
  composio_denylist_disabled?: boolean;
  composio_denylist_allow?: string[];
}

export type PolicyDecision =
  | { denied: false }
  | {
      denied: true;
      pattern: string;
      source: "default" | "workspace";
    };

export function isDeniedByPolicy(
  toolSlug: string,
  policy: WorkspaceComposioPolicy,
): PolicyDecision {
  // (1) allow-list short-circuits everything.
  if (policy.composio_denylist_allow?.includes(toolSlug)) {
    return { denied: false };
  }

  // (2) default patterns.
  if (!policy.composio_denylist_disabled) {
    for (const re of DEFAULT_DENYLIST) {
      if (re.test(toolSlug)) {
        return { denied: true, pattern: re.source, source: "default" };
      }
    }
  }

  // (3) workspace-custom patterns.
  for (const raw of policy.composio_denylist ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(raw);
    } catch {
      // Skip invalid regex — never block on a malformed pattern.
      continue;
    }
    if (re.test(toolSlug)) {
      return { denied: true, pattern: raw, source: "workspace" };
    }
  }

  return { denied: false };
}

/**
 * Load the composio policy from workspaces.agent_settings. Returns an
 * empty policy if the row is missing or agent_settings is null — that
 * means "defaults apply" per the plan.
 */
export async function loadComposioPolicy(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
): Promise<WorkspaceComposioPolicy> {
  const rows = await sql<
    Array<{ agent_settings: Record<string, unknown> | null }>
  >`SELECT agent_settings FROM public.workspaces WHERE id = ${workspaceId} LIMIT 1`;
  const settings = (rows[0]?.agent_settings ?? {}) as Record<string, unknown>;
  return {
    composio_denylist: Array.isArray(settings.composio_denylist)
      ? (settings.composio_denylist as string[])
      : undefined,
    composio_denylist_disabled:
      typeof settings.composio_denylist_disabled === "boolean"
        ? (settings.composio_denylist_disabled as boolean)
        : undefined,
    composio_denylist_allow: Array.isArray(settings.composio_denylist_allow)
      ? (settings.composio_denylist_allow as string[])
      : undefined,
  };
}

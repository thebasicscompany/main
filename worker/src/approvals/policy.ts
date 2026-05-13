// C.3 — Default approval policies + approval_rules lookup.
//
// Each sensitive tool gets a `policy(args)` inspector that says whether
// THIS specific call should pause for a user decision. Inspectors are
// pure-sync (no I/O) so they sit cleanly inside the existing
// `defineTool`'s `approval` field shape (C.2).
//
// Rule lookup is separate, async, and DB-backed:
//   lookupApprovalRule(sql, workspaceId, toolName, args)
// runs JSONB-containment against `approval_rules.args_pattern_json`
// for the workspace. C.4 wraps both: if rule matches, skip the gate.

import type postgres from "postgres";
import type { ToolApprovalDecision } from "@basics/shared";

// Plan §C.3 (and §B.8 denylist) share the same "this slug mutates"
// regex set. The denylist HARD-blocks; the approval gate SOFT-pauses.
// Once a workspace allow-lists a particular slug (B.8), this approval
// inspector still kicks in and asks the user every time.
const COMPOSIO_MUTATING_RE = /_(DELETE|REMOVE|DROP|PURGE|WIPE|SEND|CREATE|UPDATE|MODIFY|SET)_/;

const BASH_DESTRUCTIVE_RE = /^\s*(rm\s+-rf|mv\s+|chmod\s+777|chown\s+|dd\s+|mkfs)/;

const DEFAULT_TTL_4H_SECONDS = 4 * 60 * 60;
const SMS_TTL_30M_SECONDS = 30 * 60;

export function sendEmailApproval(args: {
  to: string | string[];
}): ToolApprovalDecision {
  const toCount = Array.isArray(args.to) ? args.to.length : 1;
  if (toCount > 1) {
    return {
      required: true,
      reason: `send_email to ${toCount} recipients`,
      expiresInSeconds: DEFAULT_TTL_4H_SECONDS,
    };
  }
  return { required: false };
}

export function sendSmsApproval(_args: {
  to: string;
  body: string;
}): ToolApprovalDecision {
  // SMS always requires approval per plan §4.3.1. Shorter TTL since
  // SMS approvals are usually time-sensitive (notify-on-event flows).
  return {
    required: true,
    reason: "send_sms (always)",
    expiresInSeconds: SMS_TTL_30M_SECONDS,
  };
}

export function composioCallApproval(args: {
  toolSlug: string;
}): ToolApprovalDecision {
  if (COMPOSIO_MUTATING_RE.test(args.toolSlug)) {
    return {
      required: true,
      reason: `composio_call ${args.toolSlug} (mutating external state)`,
      expiresInSeconds: DEFAULT_TTL_4H_SECONDS,
    };
  }
  return { required: false };
}

export function bashApproval(args: {
  cmd: string;
}): ToolApprovalDecision {
  if (BASH_DESTRUCTIVE_RE.test(args.cmd)) {
    return {
      required: true,
      reason: "bash destructive pattern",
      expiresInSeconds: DEFAULT_TTL_4H_SECONDS,
    };
  }
  return { required: false };
}

// Exported regex patterns + TTLs are useful in tests + for the C.4 gate.
export const COMPOSIO_APPROVAL_RE = COMPOSIO_MUTATING_RE;
export const BASH_APPROVAL_RE = BASH_DESTRUCTIVE_RE;
export const APPROVAL_TTL_DEFAULT_S = DEFAULT_TTL_4H_SECONDS;
export const APPROVAL_TTL_SMS_S = SMS_TTL_30M_SECONDS;

/**
 * Check `approval_rules` for a non-expired row matching this workspace
 * + tool + args. Match is JSONB containment: every key in
 * `args_pattern_json` must equal the corresponding key in `args`. A
 * rule with no constraints (empty object) matches every call.
 *
 * Returns `true` when a matching rule was found and the call should
 * skip the approval gate.
 */
export async function lookupApprovalRule(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id
      FROM public.approval_rules
     WHERE workspace_id = ${workspaceId}
       AND tool_name    = ${toolName}
       AND expires_at   > now()
       AND ${sql.json(args as unknown as Parameters<typeof sql.json>[0])} @> args_pattern_json
     LIMIT 1
  `;
  return rows.length > 0;
}

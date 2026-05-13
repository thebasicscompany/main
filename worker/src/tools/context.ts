// Per-call context passed into every tool's execute(). The dispatcher
// constructs one of these per RunTask + per tool call, then hands the OC
// adapter a `resolveContext` thunk that returns it.
//
// The publish() hook becomes the worker's INSERT-into-agent_activity path
// (CLOUD-AGENT-PLAN §13 reconciliation: agent_activity is the table the
// earlier draft called `run_events` — column names: activity_type, payload,
// agent_run_id, workspace_id, account_id, created_at).

import type { CdpSession } from "@basics/harness";
import type { ComposioConnectedAccount } from "@basics/shared";
import type { SkillStore } from "../skill-store.js";
import type { SubagentRunner } from "../subagent.js";
import type { InboxesRepo } from "../inboxes-repo.js";
import type { QuotaStore } from "../quota-store.js";

export interface PublishEvent {
  /** Stored at agent_activity.activity_type. §11.1 type names: 'plan_updated', 'step_status', 'finding', 'final_answer', etc. */
  type: string;
  /** Stored at agent_activity.payload. */
  payload: Record<string, unknown>;
  /** Optional dedup key, stored at agent_activity.call_hash. */
  callHash?: string;
}

export interface WorkerToolContext {
  /** Browserbase CDP session attached for this run. */
  session: CdpSession;
  /** agent_runs.id — FK target on every agent_activity row we publish. */
  runId: string;
  workspaceId: string;
  accountId: string;
  /** Per-automation approval-rule scope (migration 0024). Set by the
   * opencode-plugin when the cloud_runs row was triggered by an automation
   * (D.3 manual / D.5 webhook / D.6 schedule). When undefined, only
   * workspace-wide rules apply. */
  automationId?: string;
  /** Filesystem sandbox root — defaults to /workspace in production, tmp dir in tests. */
  workspaceRoot: string;
  /** Real worker writes to agent_activity; tests can capture into an array. */
  publish: (event: PublishEvent) => Promise<void> | void;
  /** Skill persistence — required by skill_write; injected by the runner. */
  skillStore?: SkillStore;
  /** Inner-opencode runner — required by spawn_subagent; injected by runner. */
  subagentRunner?: SubagentRunner;
  /** Names of all registered tools — used by spawn_subagent to filter allowedTools. */
  toolRegistryNames?: ReadonlyArray<string>;
  /** Inbox CRUD — required by send_to_agent; injected by runner. */
  inboxesRepo?: InboxesRepo;
  /** Current lane id — null for single-lane workspaces. Used by send_to_agent for `from_lane_id`. */
  laneId?: string | null;
  /** Output-channel quota gate — required by send_email/send_sms; injected by runner. */
  quotaStore?: QuotaStore;
  /**
   * E.2 — per-workspace saved browser-session storage states keyed by host.
   * Wiring: opencode-plugin attaches the same pg connection used by the
   * quota gate (max:2, idle_timeout:60). Tools that navigate
   * (goto_url; eventually click_at_xy when it triggers a navigation) call
   * `loadStorageStateForUrl` to apply cookies + localStorage from
   * `workspace_browser_sites` before the page loads, so logged-in flows
   * (LinkedIn, Jira, etc.) work without each agent hitting a sign-in wall.
   */
  browserSites?: {
    sql: import("postgres").Sql<Record<string, unknown>>;
    workspaceId: string;
  };
  /**
   * E.7 — when true, the run is in dry-run mode. Mutating-outbound tools
   * (send_email/send_sms/composio_call w/ mutating slug) get intercepted
   * and recorded into `dryRunBuffer` instead of executing. Approval gates
   * are bypassed in dry-run; the preview already tells the operator what
   * would have been sent. The flag is sourced from `cloud_runs.dry_run`
   * at session boot.
   */
  dryRun?: boolean;
  /**
   * E.7 — per-run buffer that holds intercepted tool calls. Flushed into
   * `cloud_runs.dry_run_actions` at run completion. Only set when
   * `dryRun === true`.
   */
  dryRunBuffer?: import("../dry-run/interceptor.js").DryRunBuffer;
  /**
   * B.3 — ACTIVE Composio connected accounts for this run, keyed by
   * toolkit slug (e.g. "GMAIL", "GITHUB"). Populated at session boot by
   * the opencode-plugin via resolveConnectedAccounts(); empty Map when
   * Composio is down or no API key is wired. composio_call / composio_list_tools
   * read from this to pick the right connectedAccountId per tool call.
   */
  composio?: {
    accountsByToolkit: Map<string, ComposioConnectedAccount>;
    /** B.4 cache for /tools schema discovery, attached when the plugin instantiates one. */
    cache?: import("../composio/cache.js").PgComposioToolCache;
    /**
     * B.5 audit's pg connection. composio_call (B.7) uses this to write
     * external_action_audit rows. Same client as the cache's `sql`.
     */
    auditSql?: import("postgres").Sql<Record<string, unknown>>;
    /**
     * B.8 per-workspace mutating-action denylist policy, loaded at session
     * boot from workspaces.agent_settings. composio_call short-circuits
     * with denied_by_policy when isDeniedByPolicy(toolSlug, policy) hits.
     */
    policy?: import("../composio/denylist.js").WorkspaceComposioPolicy;
  };
}

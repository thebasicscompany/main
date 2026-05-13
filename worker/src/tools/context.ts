// Per-call context passed into every tool's execute(). The dispatcher
// constructs one of these per RunTask + per tool call, then hands the OC
// adapter a `resolveContext` thunk that returns it.
//
// The publish() hook becomes the worker's INSERT-into-agent_activity path
// (CLOUD-AGENT-PLAN §13 reconciliation: agent_activity is the table the
// earlier draft called `run_events` — column names: activity_type, payload,
// agent_run_id, workspace_id, account_id, created_at).

import type { CdpSession } from "@basics/harness";
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
}

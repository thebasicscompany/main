/**
 * Mirrors `api/src/db/schema.ts` and `api/src/orchestrator/runState.ts`.
 * Keeping these aligned means the swap-to-API in W4+ is a hook-impl change,
 * not a UI refactor.
 */

export type RunStatus =
  | "pending"
  | "booting"
  | "running"
  | "paused"
  | "paused_by_user"
  | "verifying"
  | "completed"
  | "failed"
  | "verified"
  | "unverified";

export type RunTrigger = "manual" | "scheduled" | "api";

export type Run = {
  id: string;
  workflowId: string;
  workflowName: string;
  workspaceId: string;
  status: RunStatus;
  trigger: RunTrigger;
  triggeredBy?: { id: string; name: string };
  browserbaseSessionId?: string;
  liveUrl?: string;
  takeoverActive: boolean;
  startedAt: string;
  completedAt?: string;
  verifiedAt?: string;
  costCents?: number;
  stepCount: number;
  errorSummary?: string;
};

export type Workflow = {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule?: string;
  enabled: boolean;
  requiredCredentials: string[];
  checkModules: string[];
  createdAt: string;
  updatedAt: string;
};

export type RunStepKind =
  | "model_thinking"
  | "model_tool_use"
  | "tool_call"
  | "approval"
  | "check"
  | "user_takeover";

export type RunStep = {
  id: string;
  runId: string;
  stepIndex: number;
  kind: RunStepKind;
  payload: RunStepPayload;
  createdAt: string;
};

export type RunStepPayload =
  | { kind: "model_thinking"; text: string }
  | { kind: "model_tool_use"; toolName: string; reasoning: string }
  | {
      kind: "tool_call";
      toolName: string;
      params: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: string;
      durationMs: number;
      screenshotKey?: string;
    }
  | { kind: "approval"; approvalId: string; action: string; status: ApprovalStatus }
  | { kind: "check"; checkName: string; passed: boolean; evidence: Record<string, unknown> }
  | { kind: "user_takeover"; userId: string; userName: string; reason?: string };

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export type Approval = {
  id: string;
  runId: string;
  workspaceId: string;
  action: string;
  reason: string;
  params: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: { id: string; name: string };
};

export type CheckResult = {
  name: string;
  passed: boolean;
  message: string;
  evidence?: Record<string, unknown>;
};

export type RunsFilter = {
  status?: RunStatus | "all";
  workflowId?: string;
  search?: string;
};

/**
 * UI-side enrichment that joins workflow + run history. The API will
 * eventually return this shape from a `/workflows?withSummary=true`
 * endpoint or similar — for now, derived client-side from mocks.
 */
export type WorkflowSummary = Workflow & {
  successRate: number | null; // 0..1, null if no completed runs
  runsLast7d: number;
  lastRun?: {
    id: string;
    status: RunStatus;
    startedAt: string;
  };
};

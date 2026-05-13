// basics-cron-kicker Lambda — invoked by EventBridge Scheduler.
//
// Two payload shapes are supported:
//
// 1) Legacy `cloud_agents.schedule` path (created by POST /v1/schedules):
//    { cloudAgentId, workspaceId, accountId, goal, vars?, model?, laneId? }
//
// 2) D.6 automation-aware path (created by D.4's automation CRUD when
//    an automation declares a `schedule` trigger):
//    { automationId, workspaceId, accountId, goal, triggeredBy:'schedule' }
//
// The handler generates a fresh runId, INSERTs a cloud_runs row, and
// sends a run job to basics-runs.fifo. The dispatcher Lambda picks it
// up the same way as POST /v1/runs or POST /v1/automations/:id/run.

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

interface KickerInput {
  // Legacy fields (cloud_agents path).
  cloudAgentId?: string;
  // D.6 fields (automation path).
  automationId?: string;
  triggeredBy?: "schedule" | "manual" | "composio_webhook";
  // Shared.
  workspaceId: string;
  accountId: string;
  goal?: string;
  /** Optional template substitutions like {VIDEO_ID} → "abc123". */
  vars?: Record<string, string>;
  model?: string;
  laneId?: string;
}

const REGION = process.env.AWS_REGION ?? "us-east-1";
const sqs = new SQSClient({ region: REGION });

let _sql: ReturnType<typeof postgres> | null = null;
function db(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.DATABASE_URL_POOLER;
    if (!url) throw new Error("DATABASE_URL_POOLER not set");
    _sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
  }
  return _sql;
}

function substituteVars(s: string, vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, v),
    s,
  );
}

async function ensureAdHocAgent(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  accountId: string,
): Promise<string> {
  const existing = await sql<Array<{ id: string }>>`
    SELECT id FROM public.cloud_agents
     WHERE workspace_id = ${workspaceId} AND agent_id = 'ad-hoc'
     LIMIT 1
  `;
  if (existing[0]) return existing[0].id;
  const created = await sql<Array<{ id: string }>>`
    INSERT INTO public.cloud_agents
      (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
    VALUES
      (${workspaceId}, ${accountId}, 'ad-hoc', 'Schedule-triggered automation runs',
       'manual', 'active', ${workspaceId}, 'harness')
    RETURNING id
  `;
  return created[0]!.id;
}

interface AutomationRow {
  id: string;
  goal: string;
  version: number;
  archived_at: string | null;
  workspace_id: string;
}

export async function handler(event: KickerInput): Promise<{ runId: string; skipped?: true; reason?: string }> {
  if (!event.workspaceId || !event.accountId) {
    throw new Error("kicker: missing workspaceId/accountId");
  }

  const queueUrl = process.env.RUNS_QUEUE_URL;
  if (!queueUrl) throw new Error("RUNS_QUEUE_URL not set");

  const sql = db();
  const runId = randomUUID();

  // ── D.6 automation path ──────────────────────────────────────────────
  if (event.automationId) {
    const rows = await sql<Array<AutomationRow>>`
      SELECT id, goal, version, archived_at::text AS archived_at, workspace_id::text AS workspace_id
        FROM public.automations
       WHERE id = ${event.automationId}
       LIMIT 1
    `;
    const automation = rows[0];
    if (!automation || automation.archived_at) {
      console.warn("kicker: automation missing or archived; skipping run", {
        automationId: event.automationId,
        archived: Boolean(automation?.archived_at),
      });
      return { runId, skipped: true, reason: automation?.archived_at ? "archived" : "not_found" };
    }
    if (automation.workspace_id !== event.workspaceId) {
      // Defensive: the schedule's snapshotted workspaceId doesn't match
      // the current automation row. Could mean the automation was moved.
      console.warn("kicker: workspace mismatch between schedule and automation", {
        automationId: automation.id,
        schedule_ws: event.workspaceId,
        automation_ws: automation.workspace_id,
      });
    }

    // Read the CURRENT goal + version (so edits to the automation reflect
    // in the next firing without recreating the schedule).
    const goal = substituteVars(automation.goal, event.vars);
    const cloudAgentId = await ensureAdHocAgent(sql, automation.workspace_id, event.accountId);

    await sql`
      INSERT INTO public.cloud_runs
        (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
         automation_id, automation_version, triggered_by, inputs)
      VALUES
        (${runId}, ${cloudAgentId}, ${automation.workspace_id}, ${event.accountId},
         'pending', 'live', ${automation.id}, ${automation.version}, 'schedule',
         ${sql.json({})})
    `;

    const body = JSON.stringify({
      runId,
      workspaceId: automation.workspace_id,
      accountId: event.accountId,
      goal,
      automationId: automation.id,
      automationVersion: automation.version,
      triggeredBy: "schedule",
      inputs: {},
      ...(event.model ? { model: event.model } : {}),
    });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: automation.workspace_id,
        MessageDeduplicationId: `kicker-${runId}`,
      }),
    );

    console.log("kicker: dispatched automation schedule run", {
      runId,
      workspaceId: automation.workspace_id,
      automationId: automation.id,
      automationVersion: automation.version,
    });
    return { runId };
  }

  // ── Legacy cloud_agents path ─────────────────────────────────────────
  if (!event.cloudAgentId || !event.goal) {
    throw new Error(
      "kicker: missing required fields (cloudAgentId/goal) for legacy path, and no automationId set",
    );
  }
  const goal = substituteVars(event.goal, event.vars);

  await sql`
    INSERT INTO public.cloud_runs (id, cloud_agent_id, workspace_id, account_id, status, run_mode)
    VALUES (${runId}, ${event.cloudAgentId}, ${event.workspaceId}, ${event.accountId}, 'pending', 'live')
  `;

  const body = JSON.stringify({
    runId,
    workspaceId: event.workspaceId,
    accountId: event.accountId,
    goal,
    ...(event.model ? { model: event.model } : {}),
  });
  const groupId = `${event.workspaceId}:${event.laneId ?? "default"}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: `kicker-${runId}`,
    }),
  );

  console.log("kicker: dispatched legacy cloud_agent run", {
    runId,
    workspaceId: event.workspaceId,
    cloudAgentId: event.cloudAgentId,
  });
  return { runId };
}

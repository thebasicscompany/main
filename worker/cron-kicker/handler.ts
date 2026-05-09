// basics-cron-kicker Lambda — invoked by EventBridge Scheduler.
// Generates a fresh runId, INSERTs an agent_runs row, then sends a run
// job to basics-runs.fifo. This is the bridge between Scheduler (which
// can't generate dynamic runIds) and our SQS-driven pool dispatcher.

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

interface KickerInput {
  cloudAgentId: string;
  workspaceId: string;
  accountId: string;
  goal: string;
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

export async function handler(event: KickerInput): Promise<{ runId: string }> {
  if (!event.cloudAgentId || !event.workspaceId || !event.accountId || !event.goal) {
    throw new Error(
      "kicker: missing required fields (cloudAgentId/workspaceId/accountId/goal)",
    );
  }
  const runId = randomUUID();
  const goal = substituteVars(event.goal, event.vars);

  const sql = db();
  await sql`
    INSERT INTO public.cloud_runs (id, cloud_agent_id, workspace_id, account_id, status, run_mode)
    VALUES (${runId}, ${event.cloudAgentId}, ${event.workspaceId}, ${event.accountId}, 'pending', 'live')
  `;

  const queueUrl = process.env.RUNS_QUEUE_URL;
  if (!queueUrl) throw new Error("RUNS_QUEUE_URL not set");

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

  console.log("kicker: dispatched run", {
    runId,
    workspaceId: event.workspaceId,
    cloudAgentId: event.cloudAgentId,
  });
  return { runId };
}

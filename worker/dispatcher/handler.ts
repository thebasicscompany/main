// basics-dispatcher Lambda handler — SQS event source.
//
// H.3 — multi-tenant pool routing. For each SQS run job:
//   1. Pick a pool with `slots_used < slots_max AND status='active'` and
//      verify ECS task is alive via DescribeTasks.
//   2. If found: INCREMENT slots_used + pg_notify the pool channel with
//      run JSON. The pool host (basics-worker process running
//      `opencode serve`) translates that into POST /session +
//      POST /session/:id/prompt_async.
//   3. If no pool has capacity: ecs:RunTask a fresh pool. The new pool
//      registers itself on boot, then loops on its own LISTEN channel.
//      The current run gets queued into pool_runs and re-NOTIFY'd once
//      the new pool's INSERT into opencode_pools fires.
//      (Implementation: launch task; on next dispatcher invocation the
//      pool will be ready.)

import {
  ECSClient,
  DescribeTasksCommand,
  RunTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import postgres from "postgres";

interface SQSRecord {
  messageId: string;
  body: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, unknown>;
}
interface SQSEvent {
  Records: SQSRecord[];
}

interface RunJob {
  runId: string;
  workspaceId: string;
  accountId?: string;
  workflowId?: string;
  inputs?: Record<string, unknown>;
  goal?: string;
  model?: string;
  // D.9 automation context (set by D.3 manual + D.5 webhook + D.6 schedule paths).
  automationId?: string;
  automationVersion?: number;
  triggeredBy?: "manual" | "schedule" | "composio_webhook";
  // J.1 — authoring runs are long-lived multi-turn opencode sessions.
  runMode?: "live" | "test" | "authoring";
}

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ecs = new ECSClient({ region: REGION });

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env var: ${key}`);
  return v;
}

function parseSubnetIds(): string[] {
  const raw = requireEnv("WORKER_SUBNET_IDS");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    throw new Error(`WORKER_SUBNET_IDS must be a JSON array; got ${raw}`);
  }
  return parsed as string[];
}

let _sql: ReturnType<typeof postgres> | null = null;
function db(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = requireEnv("DATABASE_URL_POOLER");
    // pg_notify uses the regular pooled connection — it's a function call
    // (parameterizable), unlike LISTEN which needs session mode.
    _sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
  }
  return _sql;
}

interface PoolRow {
  pool_id: string;
  task_arn: string;
  cluster: string;
  slots_used: number;
  slots_max: number;
  last_activity_at: string;
}

/** Pick the pool with the most free capacity that has a live ECS task. */
async function pickAvailablePool(): Promise<PoolRow | null> {
  const sql = db();
  const rows = await sql<PoolRow[]>`
    SELECT pool_id, task_arn, cluster, slots_used, slots_max,
           last_activity_at::text AS last_activity_at
      FROM public.cloud_pools
     WHERE status = 'active'
       AND slots_used < slots_max
       AND last_activity_at > now() - interval '4 minutes'
     ORDER BY slots_used ASC, last_activity_at DESC
     LIMIT 5
  `;
  for (const r of rows) {
    try {
      const out = await ecs.send(
        new DescribeTasksCommand({ cluster: r.cluster, tasks: [r.task_arn] }),
      );
      const t = out.tasks?.[0];
      if (t && t.lastStatus !== "STOPPED" && t.lastStatus !== "DEPROVISIONING") {
        return r;
      }
    } catch {
      // skip pools we can't verify
    }
  }
  return null;
}

async function incrementPoolSlots(poolId: string): Promise<void> {
  const sql = db();
  await sql`
    UPDATE public.cloud_pools
       SET slots_used = slots_used + 1,
           last_activity_at = now()
     WHERE pool_id = ${poolId}
  `;
}

async function notifyPool(
  poolId: string,
  job: RunJob,
): Promise<void> {
  const sql = db();
  // J.8 — Postgres NOTIFY payload is hard-capped at 8000 bytes. Once
  // J.2/J.4 layered a system prompt + iteration framing + transcript
  // replay onto authoring runs, the wrapped goal regularly exceeded
  // 10–13 KB and pg_notify threw "payload string too long" — leaving
  // the run stuck in pending. Persist the goal to
  // cloud_runs.prompt_snapshot (column already exists, was unused)
  // and have the worker SELECT it on NOTIFY receipt. Inputs travel via
  // cloud_runs.inputs (already populated by the API insert), worker
  // reads from there too.
  if (job.goal) {
    await sql`
      UPDATE public.cloud_runs
         SET prompt_snapshot = ${job.goal}
       WHERE id = ${job.runId}
    `;
  }
  const channel = `pool_${poolId.replace(/-/g, "_")}`;
  const payload = JSON.stringify({
    runId: job.runId,
    workspaceId: job.workspaceId,
    accountId: job.accountId,
    model: job.model,
    // No `goal` field — worker reads from cloud_runs.prompt_snapshot.
    // No `inputs` field — worker reads from cloud_runs.inputs.
    ...(job.automationId ? { automationId: job.automationId } : {}),
    ...(job.automationVersion !== undefined ? { automationVersion: job.automationVersion } : {}),
    ...(job.triggeredBy ? { triggeredBy: job.triggeredBy } : {}),
    ...(job.runMode ? { runMode: job.runMode } : {}),
  });
  await sql`SELECT pg_notify(${channel}, ${payload})`;
}

async function launchPoolTask(): Promise<Task> {
  const cluster = requireEnv("AGENT_CLUSTER_NAME");
  const taskDef = requireEnv("WORKER_TASK_DEFINITION_ARN");
  const sgId = requireEnv("WORKER_SECURITY_GROUP_ID");
  const subnetIds = parseSubnetIds();

  const cmd = new RunTaskCommand({
    cluster,
    taskDefinition: taskDef,
    capacityProviderStrategy: [
      { capacityProvider: "FARGATE_SPOT", weight: 3, base: 0 },
      { capacityProvider: "FARGATE", weight: 1, base: 0 },
    ],
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: subnetIds,
        securityGroups: [sgId],
        assignPublicIp: "DISABLED",
      },
    },
    // No containerOverrides for env: the pool host self-registers + pulls
    // jobs via Postgres NOTIFY. The legacy 1:1 path still works when
    // RUN_ID + GOAL are set; pool launches don't set them.
    overrides: {
      containerOverrides: [
        {
          name: "basics-worker",
          environment: [
            // Platform creds already baked into the task def — pass-throughs
            // are kept here for clarity, not because they're required.
            { name: "POOL_HOST", value: "true" },
          ],
        },
      ],
    },
    propagateTags: "TASK_DEFINITION",
    enableExecuteCommand: false,
    count: 1,
  });
  const result = await ecs.send(cmd);
  if (result.failures?.length) {
    throw new Error(`ecs:RunTask failed: ${JSON.stringify(result.failures)}`);
  }
  const t = result.tasks?.[0];
  if (!t) throw new Error("ecs:RunTask returned no tasks");
  return t;
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    let job: RunJob;
    try {
      job = JSON.parse(record.body) as RunJob;
    } catch (err) {
      console.error("dispatcher: malformed SQS body", {
        messageId: record.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!job.runId || !job.workspaceId) {
      console.error("dispatcher: SQS body missing runId/workspaceId", {
        messageId: record.messageId,
      });
      continue;
    }

    // PR 1 — drop the message if the run was cancelled before SQS delivery.
    // The api's cancel route flips status to 'cancelled' for pending runs
    // (no binding yet); without this gate the dispatcher would happily
    // route a cancelled run to a pool and consume a slot for nothing.
    const statusRows = await db()<{ status: string }[]>`
      SELECT status FROM public.cloud_runs WHERE id = ${job.runId} LIMIT 1
    `;
    const currentStatus = statusRows[0]?.status;
    if (currentStatus === "cancelled") {
      console.log("dispatcher: skipping cancelled run", {
        runId: job.runId,
        messageId: record.messageId,
      });
      continue;
    }
    if (
      currentStatus === "completed" ||
      currentStatus === "failed" ||
      currentStatus === "skipped" ||
      currentStatus === "killed"
    ) {
      console.log("dispatcher: skipping already-terminal run", {
        runId: job.runId,
        status: currentStatus,
      });
      continue;
    }

    const pool = await pickAvailablePool();
    if (pool) {
      await incrementPoolSlots(pool.pool_id);
      await notifyPool(pool.pool_id, job);
      console.log("dispatcher: NOTIFY routed to pool", {
        poolId: pool.pool_id,
        runId: job.runId,
        slotsUsed: pool.slots_used + 1,
        slotsMax: pool.slots_max,
      });
      continue;
    }

    // No pool with capacity → launch a fresh one. The current run will be
    // re-dispatched on the next SQS delivery once the new pool registers.
    // To avoid losing the run, we ALSO insert a pending row that the new
    // pool will pick up on its first heartbeat.
    const task = await launchPoolTask();
    console.log("dispatcher: no pool available, launched fresh", {
      taskArn: task.taskArn,
      runId: job.runId,
    });
    // Drop the message? FIFO retains it: by NOT calling sqs:DeleteMessage
    // explicitly (Lambda handles it via successful return), we'd lose it.
    // Throw so SQS redrives after visibilityTimeout — by then the new pool
    // is up and pickAvailablePool will succeed.
    throw new Error(
      `no_pool_capacity: launched ${task.taskArn}; redriving runId=${job.runId}`,
    );
  }
}

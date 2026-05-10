/**
 * basics-pool-autoscaler — periodic Lambda (EventBridge rate(1 minute))
 * that maintains the cloud-agent pool fleet.
 *
 * One tick does five things in order, each isolated in try/catch so a
 * single step failing doesn't block the others:
 *
 *   1. reconcileSlots()       — recompute slots_used per pool from the
 *                                count of active bindings. Catches drift
 *                                from missed terminal events.
 *   2. filterZombiePools()    — pools with status='active' but whose ECS
 *                                task is STOPPED/DEPROVISIONING get
 *                                flipped to 'dead' so the dispatcher's
 *                                pickAvailablePool excludes them.
 *   3. sweepOrphanBindings()  — bindings older than ORPHAN_BINDING_MS
 *                                with ended_at IS NULL get a cancel
 *                                NOTIFY. Defends against a pool task
 *                                SIGKILL that drops the in-process
 *                                hard-timeout sweep.
 *   4. evaluateScale()        — if empty_pools < MIN_EMPTY_POOLS and
 *                                projected pool count < MAX_POOLS,
 *                                ecs:RunTask one fresh pool. "Empty"
 *                                means slots_used=0 — the model is
 *                                "always keep one fully-idle spare
 *                                ready to absorb the next batch", not
 *                                "maintain N free slots overall".
 *   5. reapIdlePools()        — pools with slots_used=0 AND
 *                                last_activity_at < now() - REAP_AFTER_MS
 *                                AND zero open bindings get StopTask'd
 *                                and flipped to 'draining' (the pool's
 *                                idle-stop watchdog will eventually
 *                                flip 'draining' → 'dead' on graceful
 *                                shutdown; we set 'draining' immediately
 *                                so the dispatcher stops routing).
 *
 * Env:
 *   DATABASE_URL_POOLER          — Supavisor URL (required)
 *   AGENT_CLUSTER_NAME           — ECS cluster (required)
 *   WORKER_TASK_DEFINITION_ARN   — versioned task def ARN (required)
 *   WORKER_SECURITY_GROUP_ID     — required for RunTask network config
 *   WORKER_SUBNET_IDS            — JSON array of subnet IDs (required)
 *   AUTOSCALER_ENABLED           — "true"/"false", default "true"
 *   MIN_EMPTY_POOLS              — default 1 (always keep one spare empty)
 *   REAP_AFTER_MS                — default 600000 (10 min)
 *   ORPHAN_BINDING_MS            — default 1800000 (30 min)
 *   MAX_POOLS                    — default 10
 */

import {
  ECSClient,
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import postgres from "postgres";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ecs = new ECSClient({ region: REGION });

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`autoscaler: missing required env var: ${key}`);
  return v;
}

function envNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
    _sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
  }
  return _sql;
}

interface PoolRow {
  pool_id: string;
  task_arn: string;
  cluster: string;
  status: string;
  slots_used: number;
  slots_max: number;
  last_activity_at: string;
}

interface OrphanBinding {
  session_id: string;
  run_id: string;
  pool_id: string;
  created_at: string;
}

const MIN_EMPTY_POOLS = envNumber("MIN_EMPTY_POOLS", 1);
const REAP_AFTER_MS = envNumber("REAP_AFTER_MS", 10 * 60_000);
const ORPHAN_BINDING_MS = envNumber("ORPHAN_BINDING_MS", 30 * 60_000);
const MAX_POOLS = envNumber("MAX_POOLS", 10);
const ENABLED = (process.env.AUTOSCALER_ENABLED ?? "true") === "true";

// ─────────────────────────────────────────────────────────────────────
// Step 1 — reconcileSlots
// ─────────────────────────────────────────────────────────────────────

async function reconcileSlots(): Promise<{ pools: number }> {
  const sql = db();
  const result = await sql`
    UPDATE public.cloud_pools p
       SET slots_used = COALESCE((
             SELECT count(*)::int
               FROM public.cloud_session_bindings b
              WHERE b.pool_id = p.pool_id AND b.ended_at IS NULL
           ), 0)
     WHERE p.status = 'active'
    RETURNING pool_id
  `;
  return { pools: result.length };
}

// ─────────────────────────────────────────────────────────────────────
// Step 2 — filterZombiePools
// ─────────────────────────────────────────────────────────────────────

async function filterZombiePools(): Promise<{ flagged: number }> {
  const sql = db();
  const rows = await sql<PoolRow[]>`
    SELECT pool_id, task_arn, cluster, status, slots_used, slots_max,
           last_activity_at::text AS last_activity_at
      FROM public.cloud_pools
     WHERE status = 'active'
  `;
  if (rows.length === 0) return { flagged: 0 };

  // Group task ARNs by cluster for batched DescribeTasks.
  const byCluster = new Map<string, PoolRow[]>();
  for (const r of rows) {
    const list = byCluster.get(r.cluster) ?? [];
    list.push(r);
    byCluster.set(r.cluster, list);
  }

  let flagged = 0;
  for (const [cluster, pools] of byCluster) {
    // DescribeTasks accepts up to 100 task ARNs per call.
    for (let i = 0; i < pools.length; i += 100) {
      const batch = pools.slice(i, i + 100);
      try {
        const out = await ecs.send(
          new DescribeTasksCommand({ cluster, tasks: batch.map((p) => p.task_arn) }),
        );
        const found = new Map<string, Task>();
        for (const t of out.tasks ?? []) {
          if (t.taskArn) found.set(t.taskArn, t);
        }
        for (const pool of batch) {
          const task = found.get(pool.task_arn);
          const dead =
            !task ||
            task.lastStatus === "STOPPED" ||
            task.lastStatus === "DEPROVISIONING";
          if (dead) {
            await sql`UPDATE public.cloud_pools SET status='dead' WHERE pool_id = ${pool.pool_id}`;
            flagged++;
            console.log("autoscaler: zombie pool flagged dead", {
              poolId: pool.pool_id,
              taskArn: pool.task_arn,
              taskStatus: task?.lastStatus ?? "missing",
            });
          }
        }
      } catch (e) {
        console.error("autoscaler: filterZombiePools DescribeTasks failed", e);
      }
    }
  }
  return { flagged };
}

// ─────────────────────────────────────────────────────────────────────
// Step 3 — sweepOrphanBindings
// ─────────────────────────────────────────────────────────────────────

async function sweepOrphanBindings(): Promise<{ swept: number }> {
  const sql = db();
  const orphans = await sql<OrphanBinding[]>`
    SELECT b.session_id, b.run_id::text AS run_id, b.pool_id::text AS pool_id,
           b.created_at::text AS created_at
      FROM public.cloud_session_bindings b
     WHERE b.ended_at IS NULL
       AND b.pool_id IS NOT NULL
       AND b.created_at < now() - (${ORPHAN_BINDING_MS / 1000}::int * interval '1 second')
     LIMIT 50
  `;
  if (orphans.length === 0) return { swept: 0 };

  let swept = 0;
  for (const orphan of orphans) {
    const channel = `pool_${orphan.pool_id.replace(/-/g, "_")}`;
    const payload = JSON.stringify({
      kind: "cancel",
      sessionId: orphan.session_id,
      runId: orphan.run_id,
      reason: "orphan_sweep",
    });
    try {
      await sql`SELECT pg_notify(${channel}, ${payload})`;
      console.log("autoscaler: orphan binding NOTIFY-cancelled", {
        sessionId: orphan.session_id,
        runId: orphan.run_id,
        poolId: orphan.pool_id,
        ageMs: Date.now() - new Date(orphan.created_at).getTime(),
      });
      swept++;
    } catch (e) {
      console.error("autoscaler: orphan NOTIFY failed", { orphan, e });
    }
  }
  // Defensive: if the pool that owns the binding is already dead, the
  // NOTIFY is a no-op. Mark those bindings ended directly so we don't
  // loop on them every tick.
  await sql`
    UPDATE public.cloud_session_bindings b
       SET ended_at = now()
      FROM public.cloud_pools p
     WHERE b.pool_id = p.pool_id
       AND b.ended_at IS NULL
       AND p.status = 'dead'
       AND b.created_at < now() - (${ORPHAN_BINDING_MS / 1000}::int * interval '1 second')
  `.catch((e) => console.error("autoscaler: dead-pool binding close failed", e));

  return { swept };
}

// ─────────────────────────────────────────────────────────────────────
// Step 4 — evaluateScale
// ─────────────────────────────────────────────────────────────────────

/**
 * Count ECS tasks in the worker cluster that are scheduled (PROVISIONING /
 * PENDING / ACTIVATING / RUNNING) but not yet stopped. Each represents
 * either a registered pool or one starting up — we treat them all as
 * forthcoming capacity at SLOTS_MAX so the autoscaler doesn't keep
 * launching during the 30–60s registration window.
 */
async function countInflightEcsTasks(): Promise<number> {
  const cluster = requireEnv("AGENT_CLUSTER_NAME");
  let count = 0;
  let nextToken: string | undefined;
  do {
    const list = await ecs.send(
      new ListTasksCommand({
        cluster,
        // family filter: only count basics-worker tasks (not unrelated
        // ad-hoc runs). desiredStatus=RUNNING includes everything that
        // hasn't started shutting down.
        family: "basics-worker",
        desiredStatus: "RUNNING",
        maxResults: 100,
        nextToken,
      }),
    );
    count += list.taskArns?.length ?? 0;
    nextToken = list.nextToken;
  } while (nextToken);
  return count;
}

async function evaluateScale(): Promise<{ launched: boolean; reason: string }> {
  const sql = db();
  const rows = await sql<{ active_pools: number; empty_pools: number }[]>`
    SELECT count(*)::int AS active_pools,
           count(*) FILTER (WHERE slots_used = 0)::int AS empty_pools
      FROM public.cloud_pools
     WHERE status = 'active'
       AND last_activity_at > now() - interval '4 minutes'
  `;
  const stats = rows[0] ?? { active_pools: 0, empty_pools: 0 };

  // ECS tasks that exist but haven't registered themselves in
  // cloud_pools yet are "starting" pools — they register at 0/5, so
  // each in-flight task counts as one future empty pool. Prevents the
  // double-launch race where the autoscaler keeps launching during
  // the 30–60s registration window.
  const ecsTasks = await countInflightEcsTasks();
  const inflight = Math.max(0, ecsTasks - stats.active_pools);
  const projectedEmpty = stats.empty_pools + inflight;
  const projectedTotal = stats.active_pools + inflight;

  if (projectedTotal >= MAX_POOLS) {
    return {
      launched: false,
      reason: `at_max_pools(${MAX_POOLS}, projected=${projectedTotal})`,
    };
  }
  if (projectedEmpty >= MIN_EMPTY_POOLS) {
    return {
      launched: false,
      reason: `spare_ok(empty=${stats.empty_pools}+inflight=${inflight}=projected=${projectedEmpty}, min=${MIN_EMPTY_POOLS})`,
    };
  }
  // No empty spare available — launch one.
  try {
    const task = await launchPoolTask();
    console.log("autoscaler: launched fresh pool", {
      taskArn: task.taskArn,
      reason: `no_empty_spare(empty=${stats.empty_pools}, inflight=${inflight}, projected=${projectedEmpty}, min=${MIN_EMPTY_POOLS}, total=${stats.active_pools})`,
    });
    return {
      launched: true,
      reason: `launched(empty=${stats.empty_pools}, inflight=${inflight}, projected=${projectedEmpty})`,
    };
  } catch (e) {
    console.error("autoscaler: launchPoolTask failed", e);
    return { launched: false, reason: `launch_failed: ${(e as Error).message}` };
  }
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
    overrides: {
      containerOverrides: [
        {
          name: "basics-worker",
          environment: [{ name: "POOL_HOST", value: "true" }],
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

// ─────────────────────────────────────────────────────────────────────
// Step 5 — reapIdlePools
// ─────────────────────────────────────────────────────────────────────

async function reapIdlePools(): Promise<{ reaped: number; preserved: number }> {
  const sql = db();
  // "Idle" must use a signal the worker's 30s heartbeat doesn't bump.
  // last_activity_at is updated by bumpHeartbeat every tick regardless of
  // work — it's a liveness signal, not a work-recency signal. We check
  // the bindings table instead.
  //
  // Reap criteria (all four must hold):
  //   - status='active'                     pool is alive in DB
  //   - slots_used=0                        not currently serving
  //   - no open bindings                    nothing in flight
  //   - has served traffic at least once    untouched spares are
  //                                         left alone — those idle out
  //                                         via the worker's own
  //                                         IDLE_STOP_MS=15min path.
  //   - no binding in last REAP_AFTER_MS    the work it served is old
  //
  // ORDER BY started_at ASC keeps the freshest pools as spares (oldest
  // get reaped first).
  const candidates = await sql<PoolRow[]>`
    SELECT p.pool_id, p.task_arn, p.cluster, p.status,
           p.slots_used, p.slots_max,
           p.last_activity_at::text AS last_activity_at
      FROM public.cloud_pools p
     WHERE p.status = 'active'
       AND p.slots_used = 0
       AND NOT EXISTS (
         SELECT 1 FROM public.cloud_session_bindings b
          WHERE b.pool_id = p.pool_id AND b.ended_at IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM public.cloud_session_bindings b
          WHERE b.pool_id = p.pool_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.cloud_session_bindings b
          WHERE b.pool_id = p.pool_id
            AND b.created_at > now() - (${REAP_AFTER_MS / 1000}::int * interval '1 second')
       )
     ORDER BY p.started_at ASC
     LIMIT 5
  `;

  // Respect MIN_EMPTY_POOLS — don't reap so aggressively that the next
  // autoscaler tick has to launch a fresh pool right back. We only
  // reap the candidates beyond the spare floor.
  const totalEmptyRows = await sql<{ count: number }[]>`
    SELECT count(*)::int FROM public.cloud_pools
     WHERE status = 'active' AND slots_used = 0
  `;
  const currentEmpty = totalEmptyRows[0]?.count ?? 0;
  const reapableCount = Math.max(0, currentEmpty - MIN_EMPTY_POOLS);
  if (candidates.length > reapableCount) {
    candidates.length = reapableCount;
  }
  const preserved = currentEmpty - candidates.length;

  let reaped = 0;
  for (const pool of candidates) {
    try {
      // Flip to draining FIRST so the dispatcher stops picking this pool.
      const draining = await sql`
        UPDATE public.cloud_pools
           SET status = 'draining'
         WHERE pool_id = ${pool.pool_id} AND status = 'active'
        RETURNING pool_id
      `;
      if (draining.length === 0) {
        // Lost the race — another autoscaler tick or the pool itself
        // already moved off 'active'. Skip.
        continue;
      }
      // Then StopTask. The pool's SIGTERM handler tears down its bb
      // sessions; ECS sets task lastStatus → STOPPED; next reconcile
      // tick (filterZombiePools) flips status='dead'.
      await ecs.send(
        new StopTaskCommand({
          cluster: pool.cluster,
          task: pool.task_arn,
          reason: "autoscaler: idle reap",
        }),
      );
      console.log("autoscaler: pool reaped", {
        poolId: pool.pool_id,
        taskArn: pool.task_arn,
        idleMs:
          Date.now() - new Date(pool.last_activity_at).getTime(),
      });
      reaped++;
    } catch (e) {
      console.error("autoscaler: reap failed", { pool, e });
    }
  }
  return { reaped, preserved };
}

// ─────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────

export async function handler(): Promise<{ ok: boolean; summary: Record<string, unknown> }> {
  if (!ENABLED) {
    console.log("autoscaler: disabled via AUTOSCALER_ENABLED env");
    return { ok: true, summary: { skipped: "disabled" } };
  }
  const t0 = Date.now();
  const summary: Record<string, unknown> = {};

  // Each step independently caught so one failure doesn't block others.
  try {
    summary.reconcile = await reconcileSlots();
  } catch (e) {
    console.error("autoscaler: reconcileSlots step failed", e);
    summary.reconcile = { error: (e as Error).message };
  }

  try {
    summary.zombies = await filterZombiePools();
  } catch (e) {
    console.error("autoscaler: filterZombiePools step failed", e);
    summary.zombies = { error: (e as Error).message };
  }

  try {
    summary.orphans = await sweepOrphanBindings();
  } catch (e) {
    console.error("autoscaler: sweepOrphanBindings step failed", e);
    summary.orphans = { error: (e as Error).message };
  }

  try {
    summary.scale = await evaluateScale();
  } catch (e) {
    console.error("autoscaler: evaluateScale step failed", e);
    summary.scale = { error: (e as Error).message };
  }

  try {
    summary.reap = await reapIdlePools();
  } catch (e) {
    console.error("autoscaler: reapIdlePools step failed", e);
    summary.reap = { error: (e as Error).message };
  }

  summary.durationMs = Date.now() - t0;
  console.log("autoscaler: tick complete", summary);
  return { ok: true, summary };
}

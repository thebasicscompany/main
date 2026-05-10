// basics-worker entry point — see CLOUD-AGENT-PLAN.md §16.1.
//
// H.3 — multi-tenant opencode pool host. The container runs
// `opencode serve --port 4096` as a long-lived child; many workspaces'
// sessions share this one process. The dispatcher Lambda picks a pool
// with capacity and pg_notify's the run JSON to our pool channel; we
// translate that into POST /session + POST /session/:id/prompt_async.
//
// Plugin (worker/src/opencode-plugin/index.ts) handles Browserbase + tool
// execution per session — keyed off opencode_session_bindings.session_id.

import postgres from "postgres";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runOnce } from "./runner.js";
import { Publisher } from "./publisher.js";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`worker: missing required env var: ${key}`);
  return v;
}

interface HealthcheckHandle {
  stop: () => void;
}

function startHealthcheckServer(): HealthcheckHandle | null {
  const port = Number(process.env.PORT ?? 8080);
  const bunGlobal = (globalThis as {
    Bun?: { serve: (init: unknown) => { stop: () => void } };
  }).Bun;
  if (!bunGlobal || typeof bunGlobal.serve !== "function") return null;
  const server = bunGlobal.serve({
    port,
    fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`worker: /healthz listening on :${port}`);
  return { stop: () => server.stop() };
}

const POOL_ID = (process.env.POOL_ID ?? randomUUID());
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
const SLOTS_MAX = Number(process.env.SLOTS_MAX ?? 5);
const IDLE_STOP_MS = Number(process.env.IDLE_STOP_MS ?? 15 * 60_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);
// PR 1 — hard ceiling per session. A wedged session (model loop, stuck tool
// call, hung Browserbase wait) would otherwise hold its slot forever.
const MAX_SESSION_DURATION_MS = Number(
  process.env.MAX_SESSION_DURATION_MS ?? 30 * 60_000,
);

interface RunMessage {
  runId: string;
  workspaceId: string;
  accountId: string;
  goal: string;
  model?: string;
}

/** PR 1 — second NOTIFY shape, used by api's POST /v1/runs/:id/cancel. */
interface CancelMessage {
  kind: "cancel";
  sessionId: string;
  runId?: string;
}

/**
 * PR 1 — sessions we cancelled out-of-band (user cancel or hard timeout).
 * The terminal handler reads this set to decide whether `session.deleted`
 * means "natural shutdown" (status=completed) or "we killed it"
 * (status=cancelled).
 */
const cancelledSessions = new Set<string>();

async function fetchTaskArn(): Promise<{ taskArn: string; privateIp: string }> {
  const meta = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!meta) return { taskArn: "unknown:not-on-ecs", privateIp: "127.0.0.1" };
  try {
    const r = await fetch(`${meta}/task`);
    if (!r.ok) return { taskArn: "unknown:meta-fetch", privateIp: "127.0.0.1" };
    const j = (await r.json()) as {
      TaskARN?: string;
      Containers?: Array<{ Networks?: Array<{ IPv4Addresses?: string[] }> }>;
    };
    const ip = j.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0] ?? "127.0.0.1";
    return { taskArn: j.TaskARN ?? "unknown:no-arn", privateIp: ip };
  } catch {
    return { taskArn: "unknown:meta-error", privateIp: "127.0.0.1" };
  }
}

async function waitForOpencodeServe(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/session`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`opencode serve did not become ready on :${port} within ${timeoutMs}ms`);
}

async function postSession(port: number): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`POST /session failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { id: string };
  return j.id;
}

const DEFAULT_MODEL = process.env.MODEL ?? "anthropic/claude-sonnet-4-5";

async function postPromptAsync(
  port: number,
  sessionId: string,
  goal: string,
  model?: string,
): Promise<void> {
  // Default to anthropic/claude-sonnet-4-5 — opencode serve otherwise
  // resolves Sonnet via amazon-bedrock which we don't have auth for.
  const chosen = model ?? DEFAULT_MODEL;
  const [providerID, ...rest] = chosen.split("/");
  const modelID = rest.join("/");
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: goal }],
    model: { providerID, modelID },
  };
  const r = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`prompt_async failed: ${r.status} ${await r.text()}`);
  }
}

function poolChannel(poolId: string): string {
  return `pool_${poolId.replace(/-/g, "_")}`;
}

async function registerPool(
  sql: ReturnType<typeof postgres>,
  poolId: string,
  taskArn: string,
  privateIp: string,
): Promise<void> {
  await sql`
    INSERT INTO public.cloud_pools
      (pool_id, task_arn, cluster, host, port, status, slots_max)
    VALUES
      (${poolId}, ${taskArn}, ${process.env.AGENT_CLUSTER_NAME ?? "basics-agent"},
       ${privateIp}, ${OPENCODE_PORT}, 'active', ${SLOTS_MAX})
    ON CONFLICT (pool_id) DO UPDATE
      SET task_arn = excluded.task_arn,
          host = excluded.host,
          port = excluded.port,
          status = 'active',
          last_activity_at = now(),
          expires_at = now() + interval '4 hours'
  `;
}

async function bumpHeartbeat(sql: ReturnType<typeof postgres>, poolId: string): Promise<void> {
  await sql`
    UPDATE public.cloud_pools SET last_activity_at = now() WHERE pool_id = ${poolId}
  `;
}

async function clearPool(sql: ReturnType<typeof postgres>, poolId: string): Promise<void> {
  await sql`UPDATE public.cloud_pools SET status='dead' WHERE pool_id = ${poolId}`;
}

/**
 * PR 1 — recompute slots_used from the authoritative source-of-truth
 * (count of active bindings) instead of incrementing/decrementing. Robust
 * against opencode-serve crashes that skip the terminal handler. Migration
 * 0017 added the supporting partial index.
 */
async function reconcileSlots(sql: ReturnType<typeof postgres>, poolId: string): Promise<void> {
  await sql`
    UPDATE public.cloud_pools
       SET slots_used = (
             SELECT count(*)::int
               FROM public.cloud_session_bindings
              WHERE pool_id = ${poolId} AND ended_at IS NULL
           ),
           last_activity_at = now()
     WHERE pool_id = ${poolId}
  `;
}

/** PR 1 — write ended_at on a binding. Called in the terminal handler. */
async function markBindingEnded(
  sql: ReturnType<typeof postgres>,
  sessionID: string,
): Promise<void> {
  await sql`
    UPDATE public.cloud_session_bindings
       SET ended_at = now()
     WHERE session_id = ${sessionID} AND ended_at IS NULL
  `;
}

/**
 * PR 1 — handle a `{kind:'cancel'}` NOTIFY. Calls DELETE /session/:id on
 * local opencode-serve; that produces a `session.deleted` event which our
 * existing /event SSE consumer picks up and routes through the terminal
 * handler (which now writes ended_at + reconciles slots + emits
 * run_cancelled because we tagged the session in cancelledSessions).
 */
async function cancelSession(
  port: number,
  sessionId: string,
): Promise<{ deleted: boolean; status: number }> {
  cancelledSessions.add(sessionId);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
    return { deleted: r.ok, status: r.status };
  } catch (e) {
    console.error("worker: cancelSession DELETE failed", { sessionId, e });
    return { deleted: false, status: 0 };
  }
}

async function insertBinding(
  sql: ReturnType<typeof postgres>,
  poolId: string,
  sessionId: string,
  msg: RunMessage,
): Promise<void> {
  await sql`
    INSERT INTO public.cloud_session_bindings
      (session_id, workspace_id, run_id, account_id, pool_id)
    VALUES
      (${sessionId}, ${msg.workspaceId}, ${msg.runId}, ${msg.accountId}, ${poolId})
    ON CONFLICT (session_id) DO NOTHING
  `;
}

/** H.3 fallback: env-driven first run for backward compat (G.1b 1:1 mode). */
async function maybeRunFromEnv(): Promise<void> {
  const runId = process.env.RUN_ID;
  const goal = process.env.GOAL;
  if (!runId || !goal) return;
  console.log("worker: env-driven first run (1:1 fallback)", { runId });
  try {
    await runOnce({
      workspaceId: requireEnv("WORKSPACE_ID"),
      runId,
      accountId: requireEnv("ACCOUNT_ID"),
      browserbaseApiKey: requireEnv("BROWSERBASE_API_KEY"),
      browserbaseProjectId: requireEnv("BROWSERBASE_PROJECT_ID"),
      databaseUrl: requireEnv("DATABASE_URL_POOLER"),
      goal,
      ...(process.env.MODEL ? { model: process.env.MODEL } : {}),
    });
  } catch (e) {
    console.error("worker: env first-run failed", e);
  }
}

async function main(): Promise<void> {
  const health = startHealthcheckServer();
  const databaseUrl = requireEnv("DATABASE_URL_POOLER");
  // LISTEN/NOTIFY needs Postgres session mode (Supavisor :5432, not :6543).
  const listenUrl = databaseUrl.replace(/:6543\b/, ":5432");
  const sql = postgres(listenUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    connection: { application_name: "basics-worker-pool" },
  });

  // 1:1 fallback path — if invoked the legacy way (env GOAL), run that
  // single goal via the existing runner subprocess pattern, then exit.
  // Pool flows take the LISTEN path below.
  if (process.env.RUN_ID && process.env.GOAL) {
    await maybeRunFromEnv();
    health?.stop();
    await sql.end({ timeout: 5 }).catch(() => undefined);
    return;
  }

  const { taskArn, privateIp } = await fetchTaskArn();
  console.log("worker: pool host starting", { POOL_ID, taskArn, privateIp });

  // H.4 — supervised opencode-serve. Respawn on unexpected exit so a
  // single LLM-side panic doesn't kill the whole pool. Capped restarts
  // within a window: too many crashes → exit and let ECS reschedule.
  const pluginPath = process.env.OPENCODE_PLUGIN_PATH ?? "/app/opencode-plugin.js";
  const opencodeConfig = JSON.stringify({ plugin: [pluginPath] });
  const RESTART_WINDOW_MS = 60_000;
  const MAX_RESTARTS_PER_WINDOW = 3;
  const restartHistory: number[] = [];
  let shuttingDown = false;
  let opencodeChild = spawnOpencodeServe(opencodeConfig);

  function spawnOpencodeServe(config: string): ReturnType<typeof spawn> {
    const child = spawn(
      process.env.OPENCODE_BIN ?? "opencode",
      ["serve", "--port", String(OPENCODE_PORT), "--hostname", "0.0.0.0"],
      {
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: config },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (c) =>
      console.log(`[opencode-serve] ${c.toString().trimEnd()}`),
    );
    child.stderr.on("data", (c) =>
      console.error(`[opencode-serve stderr] ${c.toString().trimEnd()}`),
    );
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      const now = Date.now();
      restartHistory.push(now);
      while (restartHistory.length && restartHistory[0]! < now - RESTART_WINDOW_MS) {
        restartHistory.shift();
      }
      console.error(
        `[opencode-serve] exited code=${code} signal=${signal}; restarts=${restartHistory.length}/${MAX_RESTARTS_PER_WINDOW}`,
      );
      if (restartHistory.length > MAX_RESTARTS_PER_WINDOW) {
        console.error("[opencode-serve] exceeded restart cap; giving up so ECS can reschedule");
        process.exit(1);
      }
      opencodeChild = spawnOpencodeServe(config);
    });
    return child;
  }

  await waitForOpencodeServe(OPENCODE_PORT);
  await registerPool(sql, POOL_ID, taskArn, privateIp);
  console.log(`worker: pool registered ${POOL_ID} on ${privateIp}:${OPENCODE_PORT}`);

  const databaseUrlForPub = databaseUrl;
  /** sessionID → publisher, for forwarding /event SSE events into agent_activity. */
  const publishers = new Map<string, Publisher>();
  /** sessionID → run details, to emit run_completed + decrement slots on close. */
  const inflightSessions = new Map<string, RunMessage>();
  /** sessionID → ms since epoch when run_started was emitted, for durationMs. */
  const sessionStartedAt = new Map<string, number>();

  // /event SSE consumer — forward opencode lifecycle events to per-run
  // publisher and decrement slots on session terminal events.
  startEventSseConsumer(
    OPENCODE_PORT,
    publishers,
    inflightSessions,
    sessionStartedAt,
    sql,
    POOL_ID,
  ).catch((e) => console.error("worker: /event SSE consumer crashed", e));

  // Pool channel listener.
  const channel = poolChannel(POOL_ID);
  let lastActivity = Date.now();
  const inflight: Promise<void>[] = [];
  await sql.listen(channel, (raw) => {
    const promise = (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error("worker: pool NOTIFY body not JSON; ignoring", { raw, e });
        return;
      }
      // PR 1 — cancel branch. NOTIFY payload: {kind:'cancel', sessionId, runId?}
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { kind?: string }).kind === "cancel"
      ) {
        const cancel = parsed as CancelMessage;
        if (!cancel.sessionId) {
          console.error("worker: cancel NOTIFY missing sessionId; ignoring");
          return;
        }
        console.log("worker: cancel NOTIFY received", {
          sessionId: cancel.sessionId,
          runId: cancel.runId,
        });
        const out = await cancelSession(OPENCODE_PORT, cancel.sessionId);
        // Even if the DELETE failed (e.g. session already gone), the terminal
        // handler will still fire on the next session.* event for that id, or
        // the binding will simply remain ended_at=null until heartbeat
        // reconciliation catches up.
        if (!out.deleted && out.status === 404) {
          // Session already gone — make sure binding + slot accounting reflects it.
          await markBindingEnded(sql, cancel.sessionId).catch(() => undefined);
          await reconcileSlots(sql, POOL_ID).catch(() => undefined);
        }
        lastActivity = Date.now();
        return;
      }
      const msg = parsed as RunMessage;
      if (!msg.runId || !msg.workspaceId || !msg.goal) {
        console.error("worker: NOTIFY missing fields; ignoring", msg);
        return;
      }
      console.log("worker: NOTIFY received", { runId: msg.runId });
      lastActivity = Date.now();
      try {
        const sessionId = await postSession(OPENCODE_PORT);
        await insertBinding(sql, POOL_ID, sessionId, msg);
        // Per-run publisher for SSE-forwarded events.
        const pub = new Publisher({
          databaseUrl: databaseUrlForPub,
          runId: msg.runId,
          workspaceId: msg.workspaceId,
          accountId: msg.accountId,
        });
        publishers.set(sessionId, pub);
        inflightSessions.set(sessionId, msg);
        sessionStartedAt.set(sessionId, Date.now());
        await pub.emit({
          type: "run_started",
          payload: {
            trigger: "pool-dispatch",
            startedAt: new Date().toISOString(),
            worker: "basics-worker-pool",
            poolId: POOL_ID,
            sessionId,
            goal: msg.goal,
          },
        });
        await sql`
          UPDATE public.cloud_runs
             SET status = 'running', started_at = now()
           WHERE id = ${msg.runId}
        `.catch((e) => console.error("worker: failed to mark agent_runs running", e));
        await postPromptAsync(OPENCODE_PORT, sessionId, msg.goal, msg.model);
        await bumpHeartbeat(sql, POOL_ID).catch(() => undefined);
      } catch (e) {
        console.error("worker: notify-driven dispatch failed", e);
        await reconcileSlots(sql, POOL_ID).catch(() => undefined);
      }
      lastActivity = Date.now();
    })();
    inflight.push(promise);
    promise.finally(() => {
      const i = inflight.indexOf(promise);
      if (i >= 0) inflight.splice(i, 1);
    });
  });
  console.log(`worker: LISTEN ${channel}`);

  // Idle-stop watchdog. Heartbeat every 30s; exit when both inflight=0 AND
  // last activity >= IDLE_STOP_MS ago.
  // PR 1 — also (a) sweep sessions past MAX_SESSION_DURATION_MS and force
  // cancel them, and (b) reconcile slots_used from active bindings every
  // tick so a missed terminal event eventually self-corrects.
  await new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const idle = Date.now() - lastActivity;
      if (inflight.length === 0 && idle >= IDLE_STOP_MS) {
        clearInterval(timer);
        console.log("worker: idle threshold reached", { idleMs: idle });
        resolve();
        return;
      }
      // Hard-timeout sweep: any session running past MAX_SESSION_DURATION_MS
      // gets DELETE'd. The terminal handler will mark it cancelled.
      const now = Date.now();
      for (const [sessionId, startedAt] of sessionStartedAt) {
        if (cancelledSessions.has(sessionId)) continue;
        if (now - startedAt > MAX_SESSION_DURATION_MS) {
          console.log("worker: hard-timeout cancelling session", {
            sessionId,
            runtimeMs: now - startedAt,
            maxMs: MAX_SESSION_DURATION_MS,
          });
          await cancelSession(OPENCODE_PORT, sessionId).catch(() => undefined);
        }
      }
      await bumpHeartbeat(sql, POOL_ID).catch(() => undefined);
      await reconcileSlots(sql, POOL_ID).catch(() => undefined);
    }, HEARTBEAT_MS);
  });

  await clearPool(sql, POOL_ID).catch(() => undefined);
  shuttingDown = true;
  opencodeChild.kill("SIGTERM");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  health?.stop();
}

/**
 * Subscribe to opencode-serve's /event SSE stream and forward per-session
 * events to the matching agent_activity publisher. Decrements pool slots
 * on session.idle / session.error.
 */
async function startEventSseConsumer(
  port: number,
  publishers: Map<string, Publisher>,
  inflightSessions: Map<string, RunMessage>,
  sessionStartedAt: Map<string, number>,
  sql: ReturnType<typeof postgres>,
  poolId: string,
): Promise<void> {
  // Wait for serve to be alive (already gated above, but be defensive).
  for (let i = 0; i < 30; i++) {
    try {
      const ping = await fetch(`http://127.0.0.1:${port}/session`, {
        signal: AbortSignal.timeout(1500),
      });
      if (ping.ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  while (true) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/event`);
      if (!r.body) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      const reader = r.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const evChunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          // SSE chunks: lines like `event: foo\ndata: {...}`.
          let dataLine: string | null = null;
          for (const line of evChunk.split("\n")) {
            if (line.startsWith("data: ")) dataLine = line.slice(6);
          }
          if (!dataLine) continue;
          let parsed: { type?: string; properties?: Record<string, unknown> };
          try {
            parsed = JSON.parse(dataLine);
          } catch {
            continue;
          }
          await handleOpencodeEvent(parsed, publishers, inflightSessions, sessionStartedAt, sql, poolId);
        }
      }
    } catch (e) {
      console.error("worker: /event reader errored, reconnecting", e);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

// H.5 patch — opencode emits very high-volume streaming events
// (token-by-token deltas, every-state-change updates). For agent_activity
// we only want lifecycle + final shapes. Drop the noise; keep what's
// useful for replay/debug. ~85% reduction in DB writes per run.
const NOISY_EVENT_TYPES = new Set([
  "message.part.delta",
  "message.part.updated",
  "message.updated",
  "session.status",
  "session.updated",
  "session.diff",
]);

async function handleOpencodeEvent(
  ev: { type?: string; properties?: Record<string, unknown> },
  publishers: Map<string, Publisher>,
  inflightSessions: Map<string, RunMessage>,
  sessionStartedAt: Map<string, number>,
  sql: ReturnType<typeof postgres>,
  poolId: string,
): Promise<void> {
  const type = ev.type;
  if (!type) return;
  const props = ev.properties ?? {};
  const sessionID =
    (props.sessionID as string | undefined) ??
    ((props as { info?: { sessionID?: string } }).info?.sessionID) ??
    ((props as { part?: { sessionID?: string } }).part?.sessionID) ??
    undefined;
  if (!sessionID) return;
  const pub = publishers.get(sessionID);
  if (!pub) return;
  if (!NOISY_EVENT_TYPES.has(type)) {
    // Forward useful events under our oc.* prefix.
    await pub.emit({ type: `oc.${type}`, payload: { ...props } }).catch(() => undefined);
  }

  // Terminal session events → emit run_completed/run_cancelled + cleanup.
  if (type === "session.idle" || type === "session.error" || type === "session.deleted") {
    const msg = inflightSessions.get(sessionID);
    const startedAt = sessionStartedAt.get(sessionID);
    inflightSessions.delete(sessionID);
    publishers.delete(sessionID);
    sessionStartedAt.delete(sessionID);
    const durationMs = startedAt ? Date.now() - startedAt : null;
    // PR 1 — if we explicitly DELETE'd this session (user cancel or hard
    // timeout), record it as cancelled, not completed.
    const wasCancelled = cancelledSessions.has(sessionID);
    cancelledSessions.delete(sessionID);
    // PR 1 — use 'failed' (not 'error') so the value passes the cloud_runs
    // CHECK constraint (extended in migration 0018 to also accept 'cancelled').
    const status = wasCancelled
      ? "cancelled"
      : type === "session.error"
        ? "failed"
        : "completed";
    const eventType = wasCancelled ? "run_cancelled" : "run_completed";
    try {
      await pub.emit({
        type: eventType,
        payload: {
          status:
            status === "failed"
              ? "error"
              : status === "cancelled"
                ? "cancelled"
                : "success",
          summary:
            status === "cancelled"
              ? "user_cancel_or_timeout"
              : type === "session.error"
                ? "session.error"
                : "session.idle",
          stopReason: type,
          durationMs,
          poolId,
          sessionId: sessionID,
          runId: msg?.runId,
        },
      });
    } catch {
      /* best-effort */
    }
    if (msg?.runId) {
      await sql`
        UPDATE public.cloud_runs
           SET status = ${status},
               completed_at = now(),
               duration_seconds = ${durationMs ? Math.round(durationMs / 1000) : null}
         WHERE id = ${msg.runId}
      `.catch((e) => console.error("worker: failed to mark cloud_runs terminal", e));
    }
    await pub.close().catch(() => undefined);
    // PR 1 — write ended_at on the binding then recompute slots_used from the
    // count of still-active bindings. Replaces the legacy decrementSlots() so
    // a leak (terminal event missed) self-heals on the next reconcile tick.
    await markBindingEnded(sql, sessionID).catch((e) =>
      console.error("worker: failed to mark binding ended", e),
    );
    await reconcileSlots(sql, poolId).catch((e) =>
      console.error("worker: failed to reconcile slots", e),
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("worker: fatal", err);
    process.exit(1);
  },
);

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
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { getAdapter } from "../src/poll-adapters/index.js";
// F.3-F.8 — Adapter imports trigger registration as a side effect.
// Each adapter module calls registerAdapter() on import.
import "../src/poll-adapters/googlesheets.js";
import "../src/poll-adapters/gmail.js";
import "../src/poll-adapters/googlecalendar.js";
import "../src/poll-adapters/googledrive.js";
import "../src/poll-adapters/notion.js";
import "../src/poll-adapters/airtable.js";

type KickerKind = "poll_composio_triggers";

interface KickerInput {
  // F.2 — sweep entry point for self-hosted Composio polling.
  kind?: KickerKind;
  /** H.4 — Self-invocation chain depth. EventBridge ticks default
   *  to 0; each self-invoke increments by 1; we refuse to fan out
   *  past POLL_MAX_CHAIN_DEPTH to bound the per-minute Lambda spend. */
  chainDepth?: number;
  // Legacy fields (cloud_agents path).
  cloudAgentId?: string;
  // D.6 fields (automation path).
  automationId?: string;
  triggeredBy?: "schedule" | "manual" | "composio_webhook";
  // Shared.
  workspaceId?: string;
  accountId?: string;
  goal?: string;
  /** Optional template substitutions like {VIDEO_ID} → "abc123". */
  vars?: Record<string, string>;
  model?: string;
  laneId?: string;
}

const REGION = process.env.AWS_REGION ?? "us-east-1";
const sqs = new SQSClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

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
  triggers: unknown;
}

const DEFAULT_DEBOUNCE_MS = 30_000;

/** Mirror of api/src/lib/automation-debounce.ts resolveDebounceMs(). */
function resolveDebounceMs(triggers: unknown): number {
  if (!Array.isArray(triggers)) return DEFAULT_DEBOUNCE_MS;
  let min = DEFAULT_DEBOUNCE_MS;
  for (const t of triggers as Array<{ debounce_ms?: number }>) {
    if (t && typeof t.debounce_ms === "number" && t.debounce_ms >= 0 && t.debounce_ms < min) {
      min = t.debounce_ms;
    }
  }
  return min;
}

// F.2 — Per-toolkit input mapper. Mirrors api/src/lib/composio-trigger-router.ts:
// pickInputMapper for the kicker (we can't import api/ from worker/).
// Adapters emit Composio's native payload shape; the kicker maps that
// to the worker's RunInputs shape.
function buildInputs(toolkit: string, event: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (toolkit === "googlesheets") {
    const rowData = Array.isArray(payload.row_data) ? (payload.row_data as unknown[]) : [];
    // The adapter is expected to include a `header_row` hint when
    // available so the kicker can produce a keyed `row` object.
    const headerRow = Array.isArray(payload.header_row) ? (payload.header_row as string[]) : null;
    let row: Record<string, unknown>;
    if (headerRow && headerRow.length > 0) {
      row = {};
      headerRow.forEach((h, i) => {
        if (typeof h === "string" && h.length > 0) row[h] = rowData[i] ?? null;
      });
    } else {
      // No header → fall back to positional keys (col_0, col_1, ...).
      row = Object.fromEntries(rowData.map((v, i) => [`col_${i}`, v]));
    }
    return {
      row,
      row_number: payload.row_number,
      sheet_name: payload.sheet_name,
      spreadsheet_id: payload.spreadsheet_id,
      detected_at: payload.detected_at,
    };
  }
  if (toolkit === "gmail") {
    return {
      email: {
        messageId: payload.messageId ?? payload.message_id,
        threadId: payload.threadId ?? payload.thread_id,
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        snippet: payload.snippet,
        labelIds: payload.labelIds ?? payload.label_ids,
      },
    };
  }
  // Default mapper: pass payload through under `event`.
  return { event: { type: event, toolkit, ...payload } };
}

// F.2 — One row of composio_poll_state's "due now" query.
interface DueRow {
  id: string;
  automation_id: string;
  /** H.3 — added so H.5's per-workspace rate-limit guard can group
   *  rows without re-querying automations. */
  workspace_id: string;
  trigger_index: number;
  toolkit: string;
  event: string;
  filters: Record<string, unknown>;
  state: Record<string, unknown>;
  composio_user_id: string;
  connected_account_id: string;
  consecutive_failures: number;
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2 * 60_000); // default 2 min
const POLL_MAX_CONSECUTIVE_FAILURES = Number(process.env.POLL_MAX_CONSECUTIVE_FAILURES ?? 5);
const POLL_BATCH_SIZE = Number(process.env.POLL_BATCH_SIZE ?? 100);
/** H.4 — Maximum self-invocation chain depth per EventBridge tick.
 *  Each tick can drain up to (depth+1) × POLL_BATCH_SIZE = 6 × 100 =
 *  600 rows per minute, capped to bound Lambda concurrent execution
 *  + total per-minute cost. Raise if workspaces aggregate >600
 *  active triggers; pair with H.6's reservedConcurrency cap. */
const POLL_MAX_CHAIN_DEPTH = Number(process.env.POLL_MAX_CHAIN_DEPTH ?? 5);
const SELF_INVOKE_FUNCTION_NAME =
  process.env.CRON_KICKER_FUNCTION_NAME ?? "basics-cron-kicker";
/** H.5 — Soft per-workspace rate-limit guard. When a workspace's
 *  row count within a single sweep exceeds this cap, the kicker
 *  defers their remaining rows (+1min) and emits a
 *  `workspace_throttled` activity event for observability. This is
 *  per-sweep / per-Lambda-invocation; the counter resets on cold
 *  start and across self-invocation chain hops. It's a coarse
 *  guard against one workspace burning the global Composio API
 *  key budget — durable rate-limit tracking (DB-backed counters,
 *  Composio's own 429 backoff) is out of scope for H.5. */
const POLL_MAX_CALLS_PER_WORKSPACE_PER_SWEEP = Number(
  process.env.POLL_MAX_CALLS_PER_WORKSPACE_PER_SWEEP ?? 30,
);
/** H.2 — Per-adapter hard timeout. A slow Composio response (or a
 *  bug in an adapter that never resolves) would otherwise block the
 *  remaining rows in the same sweep. 15s is generous: most adapter
 *  calls finish in 300ms-3s; 15s leaves headroom for one slow
 *  Composio HTTP round-trip while still capping the batch's
 *  worst-case duration at LIMIT × 15s. Configurable for tests. */
const ADAPTER_TIMEOUT_MS = Number(process.env.POLL_ADAPTER_TIMEOUT_MS ?? 15_000);

class PollTimeoutError extends Error {
  readonly _isPollTimeout = true as const;
  constructor(message: string) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

/** Wrap a promise in a hard timeout. The losing branch is GCed; if
 *  the adapter promise resolves AFTER the timeout, it's discarded
 *  (no leaked unhandled-rejection because we attach a noop catch). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PollTimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  // Swallow any post-timeout rejection so it doesn't surface as an
  // unhandledRejection in the Lambda log.
  p.catch(() => undefined);
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
/** H.1 — Tentative lease: when a sweep claims rows via SELECT FOR
 *  UPDATE SKIP LOCKED, it immediately bumps next_poll_at by this
 *  amount so subsequent overlapping sweeps don't pick the same rows
 *  back up the moment the transaction commits and the row lock
 *  releases. The adapter call then replaces this with the real
 *  next_poll_at (success: +POLL_INTERVAL_MS; failure: backoff). If
 *  the kicker Lambda is killed mid-sweep, the lease keeps the row
 *  invisible to other sweeps for 5 minutes — long enough for any
 *  in-flight work to finish, but short enough that a single crashed
 *  sweep doesn't starve the row indefinitely. */
const TENTATIVE_LEASE_SECONDS = Number(process.env.POLL_TENTATIVE_LEASE_SECONDS ?? 300);
/** H.3 — Per-workspace fairness cap in the sweep. With LIMIT 50 +
 *  no fairness, a workspace with 100+ due rows would monopolize
 *  every sweep window and starve other workspaces. The
 *  ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY
 *  next_poll_at) window caps each workspace at this many rows per
 *  sweep, so 10 workspaces × 5 rows each fits comfortably in
 *  POLL_BATCH_SIZE=50. Tunable: raise if most workspaces have <5
 *  active triggers so we don't undersize sweeps. */
const POLL_PER_WORKSPACE_CAP = Number(process.env.POLL_PER_WORKSPACE_CAP ?? 5);

async function pollComposioTriggers(
  sql: ReturnType<typeof postgres>,
  queueUrl: string,
): Promise<{ scanned: number; dispatched: number; paused: number; failed: number; throttled: number }> {
  const composioApiKey = process.env.COMPOSIO_API_KEY;
  if (!composioApiKey) {
    console.warn("kicker(poll): COMPOSIO_API_KEY not set; skipping sweep");
    return { scanned: 0, dispatched: 0, paused: 0, failed: 0, throttled: 0 };
  }

  // H.1 + H.3 — Atomic workspace-fair claim + tentative lease. The
  // CTE ranks due rows by next_poll_at WITHIN each workspace; the
  // outer SELECT takes the top POLL_PER_WORKSPACE_CAP rows per
  // workspace, ordered globally by next_poll_at and capped at
  // POLL_BATCH_SIZE. `FOR UPDATE OF cps SKIP LOCKED` applies to the
  // composio_poll_state base table (CTEs can't be locked directly).
  // The UPDATE-lease that follows keeps overlapping sweeps (another
  // EventBridge tick, an H.4 self-invocation, any parallel sweep)
  // skipping past these rows even after the row lock releases on
  // commit.
  const due = await sql.begin(async (tx) => {
    const claimed = await tx<Array<DueRow>>`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY next_poll_at) AS rn
          FROM public.composio_poll_state
         WHERE next_poll_at <= now() AND paused_at IS NULL
      )
      SELECT cps.id,
             cps.automation_id::text AS automation_id,
             cps.workspace_id::text AS workspace_id,
             cps.trigger_index,
             cps.toolkit, cps.event, cps.filters, cps.state,
             cps.composio_user_id, cps.connected_account_id,
             cps.consecutive_failures
        FROM public.composio_poll_state cps
        JOIN ranked r ON r.id = cps.id
       WHERE r.rn <= ${POLL_PER_WORKSPACE_CAP}
       ORDER BY cps.next_poll_at ASC
       LIMIT ${POLL_BATCH_SIZE}
         FOR UPDATE OF cps SKIP LOCKED
    `;
    if (claimed.length > 0) {
      const ids = claimed.map((r) => r.id);
      await tx`
        UPDATE public.composio_poll_state
           SET next_poll_at = now() + (${TENTATIVE_LEASE_SECONDS}::int * interval '1 second')
         WHERE id = ANY(${ids}::uuid[])
      `;
    }
    return claimed;
  });

  let dispatched = 0;
  let paused = 0;
  let failed = 0;
  let throttled = 0;
  // H.5 — Per-workspace counter for this sweep. Reset on every
  // pollComposioTriggers invocation (Lambda cold start refreshes
  // the whole runtime; warm reuse still resets here).
  const workspaceCalls = new Map<string, number>();

  for (const row of due) {
    // H.2 — Outer try/catch around the entire per-row body so a
    // throw BEFORE the inner adapter try/catch (e.g., a getAdapter
    // bug, an unexpected exception in the no-adapter branch's
    // UPDATE, a future refactor) cannot sink the batch. Caught
    // errors become per-row failures: bump consecutive_failures
    // and apply exponential backoff via the inner failure path's
    // SQL, OR if that path also threw, just log and continue.
    try {
    // H.5 — Per-workspace rate-limit guard. If this workspace has
    // already burned its share of the sweep's Composio call budget,
    // defer their remaining rows by 1 min and emit a
    // workspace_throttled activity event so the operator can see
    // they're being throttled.
    const wsCalls = workspaceCalls.get(row.workspace_id) ?? 0;
    if (wsCalls >= POLL_MAX_CALLS_PER_WORKSPACE_PER_SWEEP) {
      await sql`
        UPDATE public.composio_poll_state
           SET next_poll_at = now() + interval '1 minute'
         WHERE id = ${row.id}
      `;
      try {
        const latest = await sql<Array<{ id: string; account_id: string }>>`
          SELECT cr.id, cr.account_id::text AS account_id
            FROM public.cloud_runs cr
           WHERE cr.workspace_id = ${row.workspace_id}
             AND cr.status IN ('running','pending','awaiting_approval')
           ORDER BY cr.created_at DESC LIMIT 1
        `;
        if (latest[0]) {
          await sql`
            INSERT INTO public.cloud_activity
              (agent_run_id, workspace_id, account_id, activity_type, payload)
            VALUES
              (${latest[0].id}, ${row.workspace_id}, ${latest[0].account_id},
               'workspace_throttled',
               ${sql.json({
                 kind: "workspace_throttled",
                 reason: "composio_calls_per_sweep_cap",
                 cap: POLL_MAX_CALLS_PER_WORKSPACE_PER_SWEEP,
                 poll_state_id: row.id,
                 automation_id: row.automation_id,
                 toolkit: row.toolkit,
                 event: row.event,
               })})
          `;
        }
      } catch (logErr) {
        console.warn("kicker(poll): workspace_throttled emit failed", (logErr as Error).message);
      }
      throttled += 1;
      continue;
    }
    workspaceCalls.set(row.workspace_id, wsCalls + 1);
    const adapter = getAdapter(row.toolkit, row.event);
    if (!adapter) {
      // No adapter for this (toolkit, event). Schedule far in the
      // future so it doesn't loop tight; emit a warning. Operator
      // can teardown + re-register if they want Composio's polling.
      console.warn("kicker(poll): no adapter; backing off", {
        rowId: row.id, toolkit: row.toolkit, event: row.event,
      });
      await sql`
        UPDATE public.composio_poll_state
           SET last_polled_at = now(),
               next_poll_at = now() + interval '1 hour',
               consecutive_failures = consecutive_failures + 1
         WHERE id = ${row.id}
      `;
      failed += 1;
      continue;
    }

    try {
      // H.2 — hard 15s cap on the adapter call. A slow Composio
      // response can't block the other 49 rows in the batch.
      const result = await withTimeout(
        adapter.poll(
          {
            config: row.filters,
            composioUserId: row.composio_user_id,
            connectedAccountId: row.connected_account_id,
            composioApiKey,
          },
          row.state,
        ),
        ADAPTER_TIMEOUT_MS,
        `adapter.poll(${row.toolkit}:${row.event})`,
      );

      // Dispatch one cloud_run per newEvent.
      for (const evt of result.newEvents) {
        const inputs = buildInputs(row.toolkit, row.event, evt.payload);
        const auto = await sql<Array<{ id: string; goal: string; version: number; workspace_id: string; account_id: string }>>`
          SELECT a.id, a.goal, a.version, a.workspace_id::text AS workspace_id,
                 a.created_by::text AS account_id
            FROM public.automations a
           WHERE a.id = ${row.automation_id}
             AND a.archived_at IS NULL
             AND a.status = 'active'
           LIMIT 1
        `;
        const a = auto[0];
        if (!a) {
          console.warn("kicker(poll): automation missing/inactive; dropping event", {
            automationId: row.automation_id,
          });
          continue;
        }
        const cloudAgentId = await ensureAdHocAgent(sql, a.workspace_id, a.account_id);
        const runId = randomUUID();
        await sql`
          INSERT INTO public.cloud_runs
            (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
             automation_id, automation_version, triggered_by, inputs)
          VALUES
            (${runId}, ${cloudAgentId}, ${a.workspace_id}, ${a.account_id},
             'pending', 'live', ${a.id}, ${a.version}, 'composio_webhook',
             ${sql.json(inputs)})
        `;
        const body = JSON.stringify({
          runId,
          workspaceId: a.workspace_id,
          accountId: a.account_id,
          goal: a.goal,
          automationId: a.id,
          automationVersion: a.version,
          triggeredBy: "composio_webhook",
          inputs,
        });
        await sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: a.workspace_id,
          MessageDeduplicationId: `kicker-poll-${runId}`,
        }));
        dispatched += 1;
      }

      await sql`
        UPDATE public.composio_poll_state
           SET state = ${sql.json(result.nextState)},
               last_polled_at = now(),
               next_poll_at = now() + (${Math.ceil(POLL_INTERVAL_MS / 1000)}::int * interval '1 second'),
               consecutive_failures = 0
         WHERE id = ${row.id}
      `;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("kicker(poll): adapter failed", { rowId: row.id, error: message });
      const nextFailures = row.consecutive_failures + 1;
      if (nextFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        await sql`
          UPDATE public.composio_poll_state
             SET last_polled_at = now(),
                 consecutive_failures = ${nextFailures},
                 paused_at = now()
           WHERE id = ${row.id}
        `;
        // Best-effort emit a composio_poll_paused event into the latest
        // open run for the workspace so the operator/UI notices.
        try {
          const latest = await sql<Array<{ id: string; workspace_id: string; account_id: string }>>`
            SELECT cr.id, cr.workspace_id::text AS workspace_id, cr.account_id::text AS account_id
              FROM public.cloud_runs cr
              JOIN public.automations a ON a.id = cr.automation_id
             WHERE a.id = ${row.automation_id}
               AND cr.status IN ('running','pending','awaiting_approval')
             ORDER BY cr.created_at DESC LIMIT 1
          `;
          if (latest[0]) {
            await sql`
              INSERT INTO public.cloud_activity
                (agent_run_id, workspace_id, account_id, activity_type, payload)
              VALUES
                (${latest[0].id}, ${latest[0].workspace_id}, ${latest[0].account_id},
                 'composio_poll_paused',
                 ${sql.json({
                   kind: "composio_poll_paused",
                   poll_state_id: row.id,
                   automation_id: row.automation_id,
                   toolkit: row.toolkit,
                   event: row.event,
                   error: message,
                   consecutive_failures: nextFailures,
                 })})
            `;
          }
        } catch (logErr) {
          console.error("kicker(poll): paused-event emit failed", (logErr as Error).message);
        }
        paused += 1;
      } else {
        // Exponential-ish backoff: next attempt at base interval * 1.5^failures.
        const backoffSec = Math.ceil((POLL_INTERVAL_MS / 1000) * Math.pow(1.5, nextFailures));
        await sql`
          UPDATE public.composio_poll_state
             SET last_polled_at = now(),
                 next_poll_at = now() + (${backoffSec}::int * interval '1 second'),
                 consecutive_failures = ${nextFailures}
           WHERE id = ${row.id}
        `;
        failed += 1;
      }
    }
    } catch (outerErr) {
      // H.2 — Outer fence catches anything the inner try didn't
      // (getAdapter throw, no-adapter UPDATE failure, an unexpected
      // refactor regression). Log + count as failed; the row's
      // tentative lease (H.1) keeps it invisible to other sweeps
      // for 5 min, after which a future sweep retries idempotently.
      console.error("kicker(poll): row sink-prevention fired", {
        rowId: row.id,
        error: outerErr instanceof Error ? outerErr.message : String(outerErr),
      });
      failed += 1;
    }
  }

  return { scanned: due.length, dispatched, paused, failed, throttled };
}

export async function handler(event: KickerInput): Promise<
  | { runId: string; skipped?: true; reason?: string }
  | { sweep: "poll_composio_triggers"; scanned: number; dispatched: number; paused: number; failed: number; throttled: number }
> {
  // F.2 — Composio polling sweep entry point.
  if (event.kind === "poll_composio_triggers") {
    const queueUrl = process.env.RUNS_QUEUE_URL;
    if (!queueUrl) throw new Error("RUNS_QUEUE_URL not set");
    const sql = db();
    const chainDepth = typeof event.chainDepth === "number" ? event.chainDepth : 0;
    const sweepStart = Date.now();
    const result = await pollComposioTriggers(sql, queueUrl);
    const durationMs = Date.now() - sweepStart;
    console.log("kicker(poll): sweep done", { ...result, chainDepth, durationMs });

    // H.6 — Embedded Metrics Format (EMF) emission. CloudWatch
    // Logs auto-extracts these into the Basics/CronKicker namespace
    // (no separate PutMetricData call; free metrics via log
    // aggregation). One log line, one CloudWatch metric ingestion.
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "Basics/CronKicker",
              Dimensions: [[]],
              Metrics: [
                { Name: "scanned", Unit: "Count" },
                { Name: "dispatched", Unit: "Count" },
                { Name: "paused", Unit: "Count" },
                { Name: "failed", Unit: "Count" },
                { Name: "throttled", Unit: "Count" },
                { Name: "duration_ms", Unit: "Milliseconds" },
                { Name: "chain_depth", Unit: "Count" },
              ],
            },
          ],
        },
        scanned: result.scanned,
        dispatched: result.dispatched,
        paused: result.paused,
        failed: result.failed,
        throttled: result.throttled,
        duration_ms: durationMs,
        chain_depth: chainDepth,
      }),
    );

    // H.4 — Self-invocation chain. If we drained a full batch there
    // are probably more due rows; fan out a follow-up sweep async
    // (Lambda InvocationType=Event = fire-and-forget). Cap the chain
    // at POLL_MAX_CHAIN_DEPTH hops per EventBridge tick to bound
    // worst-case concurrent execution + per-minute cost.
    if (result.scanned === POLL_BATCH_SIZE && chainDepth < POLL_MAX_CHAIN_DEPTH) {
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: SELF_INVOKE_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({
                kind: "poll_composio_triggers",
                chainDepth: chainDepth + 1,
              }),
            ),
          }),
        );
        console.log("kicker(poll): self-invoked next hop", {
          nextChainDepth: chainDepth + 1,
        });
      } catch (e) {
        console.error("kicker(poll): self-invoke failed (non-fatal)", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    } else if (result.scanned === POLL_BATCH_SIZE && chainDepth >= POLL_MAX_CHAIN_DEPTH) {
      console.warn("kicker(poll): chain depth cap hit; remaining rows wait for next EB tick", {
        chainDepth,
        cap: POLL_MAX_CHAIN_DEPTH,
      });
    }

    return { sweep: "poll_composio_triggers", ...result };
  }

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
      SELECT id, goal, version, archived_at::text AS archived_at,
             workspace_id::text AS workspace_id, triggers
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

    // D.7 — debounce check.
    const windowMs = resolveDebounceMs(automation.triggers);
    if (windowMs > 0) {
      const intervalSec = Math.max(1, Math.ceil(windowMs / 1000));
      const recent = await sql<Array<{ id: string; workspace_id: string; account_id: string }>>`
        SELECT id, workspace_id::text AS workspace_id, account_id::text AS account_id
          FROM public.cloud_runs
         WHERE automation_id = ${automation.id}
           AND created_at > now() - (${intervalSec}::int * interval '1 second')
         ORDER BY created_at DESC LIMIT 1
      `;
      const latest = recent[0];
      if (latest) {
        await sql`
          INSERT INTO public.cloud_activity
            (agent_run_id, workspace_id, account_id, activity_type, payload)
          VALUES
            (${latest.id}, ${latest.workspace_id}, ${latest.account_id}, 'trigger_debounced',
             ${sql.json({
               kind: "trigger_debounced",
               automation_id: automation.id,
               trigger_kind: "schedule",
               window_ms: windowMs,
               debounced_at: new Date().toISOString(),
             })})
        `;
        console.log("kicker: schedule fire debounced", {
          automationId: automation.id,
          latestRunId: latest.id,
          windowMs,
        });
        return { runId: "", skipped: true, reason: "debounced" };
      }
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

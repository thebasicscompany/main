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
import { getAdapter } from "../src/poll-adapters/index.js";
// F.3-F.8 — Adapter imports trigger registration as a side effect.
// Each adapter module calls registerAdapter() on import.
import "../src/poll-adapters/googlesheets.js";
import "../src/poll-adapters/gmail.js";
import "../src/poll-adapters/googlecalendar.js";

type KickerKind = "poll_composio_triggers";

interface KickerInput {
  // F.2 — sweep entry point for self-hosted Composio polling.
  kind?: KickerKind;
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
const POLL_BATCH_SIZE = Number(process.env.POLL_BATCH_SIZE ?? 50);

async function pollComposioTriggers(
  sql: ReturnType<typeof postgres>,
  queueUrl: string,
): Promise<{ scanned: number; dispatched: number; paused: number; failed: number }> {
  const composioApiKey = process.env.COMPOSIO_API_KEY;
  if (!composioApiKey) {
    console.warn("kicker(poll): COMPOSIO_API_KEY not set; skipping sweep");
    return { scanned: 0, dispatched: 0, paused: 0, failed: 0 };
  }

  const due = await sql<Array<DueRow>>`
    SELECT id, automation_id::text AS automation_id, trigger_index,
           toolkit, event, filters, state,
           composio_user_id, connected_account_id, consecutive_failures
      FROM public.composio_poll_state
     WHERE next_poll_at <= now() AND paused_at IS NULL
     ORDER BY next_poll_at ASC
     LIMIT ${POLL_BATCH_SIZE}
  `;

  let dispatched = 0;
  let paused = 0;
  let failed = 0;

  for (const row of due) {
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
      const result = await adapter.poll(
        {
          config: row.filters,
          composioUserId: row.composio_user_id,
          connectedAccountId: row.connected_account_id,
          composioApiKey,
        },
        row.state,
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
  }

  return { scanned: due.length, dispatched, paused, failed };
}

export async function handler(event: KickerInput): Promise<
  | { runId: string; skipped?: true; reason?: string }
  | { sweep: "poll_composio_triggers"; scanned: number; dispatched: number; paused: number; failed: number }
> {
  // F.2 — Composio polling sweep entry point.
  if (event.kind === "poll_composio_triggers") {
    const queueUrl = process.env.RUNS_QUEUE_URL;
    if (!queueUrl) throw new Error("RUNS_QUEUE_URL not set");
    const sql = db();
    const result = await pollComposioTriggers(sql, queueUrl);
    console.log("kicker(poll): sweep done", result);
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

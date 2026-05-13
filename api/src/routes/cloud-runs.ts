/**
 * Cloud-agent control-plane (Phase H follow-up).
 *
 *   POST   /v1/runs                                — dispatch a one-shot run via SQS
 *   GET    /v1/runs?cloudAgentId=…&limit=&since=   — list past runs for a cloud_agent
 *   GET    /v1/runs/:id/events                     — SSE stream of agent_activity
 *   POST   /v1/runs/:id/cancel                     — cancel an in-flight run (PR 1)
 *
 * All routes require workspace JWT (mounted in app.ts). The SSE proxy
 * verifies the run's workspace before subscribing.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createClient } from '@supabase/supabase-js'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { dispatchCloudRun, UUID_RE } from '../lib/cloud-run-dispatch.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

export const cloudRunsRoute = new Hono<{ Variables: Vars }>()

const TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_cancelled'])

// Matches the cloud_runs.status CHECK constraint (migration 0018) for
// the values we treat as terminal in the cancel route.
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'skipped',
  'killed',
  'cancelled',
])

function poolChannelName(poolId: string): string {
  return `pool_${poolId.replace(/-/g, '_')}`
}

/**
 * POST /v1/runs — dispatch a one-shot cloud-agent run.
 *
 * Inserts an agent_runs row (status=pending), then sends an SQS message
 * to basics-runs.fifo. The dispatcher Lambda picks it up and routes to
 * an opencode pool, which transitions status → running → completed.
 */
cloudRunsRoute.post(
  '/',
  zValidator('json', z.object({
    goal: z.string().min(1).max(64 * 1024),
    cloudAgentId: z.string().regex(UUID_RE).optional(),
    laneId: z.string().regex(UUID_RE).optional(),
    model: z.string().optional(),
  })),
  async (c) => {
    const body = c.req.valid('json')
    try {
      const result = await dispatchCloudRun({
        workspace: c.var.workspace!,
        goal: body.goal,
        cloudAgentId: body.cloudAgentId,
        laneId: body.laneId,
        model: body.model,
      })
      if (!result) return c.json({ error: 'not_found' }, 404)
      return c.json({
        runId: result.runId,
        status: result.status,
        cloudAgentId: result.cloudAgentId,
        liveViewUrl: result.liveViewUrl,
      }, 201)
    } catch (err) {
      if (err instanceof Error && err.message === 'runs_queue_not_configured') {
        return c.json({ error: 'runs_queue_not_configured' }, 503)
      }
      throw err
    }
  },
)

/**
 * GET /v1/runs?cloudAgentId=…&limit=&since= — list past runs.
 *
 * Returns an array of run summaries, newest first. Used by the desktop
 * client's "history" panel.
 */
cloudRunsRoute.get(
  '/',
  zValidator('query', z.object({
    cloudAgentId: z.string().regex(UUID_RE).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    since: z.string().datetime().optional(),
  })),
  async (c) => {
    const ws = c.var.workspace!.workspace_id
    const q = c.req.valid('query')
    const result = (await db.execute(sql`
      SELECT id, cloud_agent_id, status, started_at::text AS started_at,
             completed_at::text AS completed_at, duration_seconds,
             result_summary, error_message,
             browserbase_session_id, live_view_url,
             created_at::text AS created_at
        FROM public.cloud_runs
       WHERE workspace_id = ${ws}
         ${q.cloudAgentId ? sql`AND cloud_agent_id = ${q.cloudAgentId}` : sql``}
         ${q.since ? sql`AND created_at >= ${q.since}::timestamptz` : sql``}
       ORDER BY created_at DESC
       LIMIT ${q.limit}
    `)) as unknown as Array<Record<string, unknown>>
    return c.json({ runs: result })
  },
)

cloudRunsRoute.get('/:id/events', async (c) => {
  const runId = c.req.param('id')
  if (!UUID_RE.test(runId)) {
    return c.json({ error: 'invalid_run_id' }, 400)
  }

  // Workspace-scope: only subscribe if the run belongs to this workspace.
  // Worker-token (no workspace claim) callers are rejected — this route
  // requires workspace JWT in app.ts wiring.
  const ws = c.var.workspace?.workspace_id
  if (!ws) return c.json({ error: 'unauthorized' }, 401)
  const ownership = (await db.execute(sql`
    SELECT id FROM public.cloud_runs
     WHERE id = ${runId} AND workspace_id = ${ws}
     LIMIT 1
  `)) as unknown as Array<{ id: string }>
  if (ownership.length === 0) return c.json({ error: 'not_found' }, 404)

  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    const cfg = getConfig()
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'supabase_not_configured' }),
      })
      return
    }

    const supabase = createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 50 } },
      },
    )

    // Replay any rows already written before subscribe — callers that
    // start curl AFTER the run kicked off still see the full history.
    const { data: backfill, error: backfillErr } = await supabase
      .from('cloud_activity')
      .select('id, activity_type, payload, created_at')
      .eq('agent_run_id', runId)
      .order('created_at', { ascending: true })
      .limit(500)
    if (backfillErr) {
      logger.error({ runId, err: backfillErr.message }, 'cloud-runs sse: backfill failed')
    } else {
      for (const row of backfill ?? []) {
        await stream.writeSSE({
          id: String(row.id),
          event: row.activity_type,
          data: JSON.stringify(row.payload ?? {}),
        })
        if (TERMINAL_EVENTS.has(row.activity_type)) {
          await supabase.removeAllChannels().catch(() => undefined)
          return
        }
      }
    }

    let closed = false
    const channel = supabase
      .channel(`cloud_activity:${runId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'cloud_activity',
          filter: `agent_run_id=eq.${runId}`,
        },
        async (payload: { new: { id: string; activity_type: string; payload: unknown } }) => {
          if (closed) return
          const row = payload.new
          await stream.writeSSE({
            id: String(row.id),
            event: row.activity_type,
            data: JSON.stringify(row.payload ?? {}),
          })
          if (TERMINAL_EVENTS.has(row.activity_type)) {
            closed = true
            await supabase.removeChannel(channel).catch(() => undefined)
          }
        },
      )
      .subscribe()

    // Hold the SSE connection open until the channel closes (terminal
    // event) or the client disconnects (Hono aborts the stream).
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true
        supabase.removeChannel(channel).catch(() => undefined)
        resolve()
      })
      const watchdog = setInterval(() => {
        if (closed) {
          clearInterval(watchdog)
          resolve()
        }
      }, 1_000)
    })
  })
})

/**
 * POST /v1/runs/:id/cancel — cancel an in-flight run (PR 1).
 *
 * Three states the run can be in:
 *
 *   1. Already terminal (completed/error/cancelled) → 200 with
 *      { cancelled: false, runStatus, reason: 'already_terminal' }. Idempotent.
 *
 *   2. Pending — no opencode session has been created yet (still queued in
 *      SQS or waiting for a pool). We mark the cloud_runs row 'cancelled'
 *      and write a run_cancelled activity row so downstream consumers stop.
 *      The dispatcher Lambda re-checks status before notifying a pool, so a
 *      late SQS delivery becomes a no-op.
 *
 *   3. Running — there is an active cloud_session_bindings row. We
 *      pg_notify the pool's channel with {kind:'cancel', sessionId, runId}.
 *      The pool host calls DELETE /session/:id on local opencode-serve;
 *      the resulting session.deleted event drives the existing terminal
 *      handler, which writes ended_at on the binding, marks the run
 *      cancelled, and reconciles slots_used.
 *
 * Auth: workspace JWT, scoped by workspace_id (404 if not yours).
 */
cloudRunsRoute.post('/:id/cancel', async (c) => {
  const runId = c.req.param('id')
  if (!UUID_RE.test(runId)) {
    return c.json({ error: 'invalid_run_id' }, 400)
  }
  const ws = c.var.workspace?.workspace_id
  if (!ws) return c.json({ error: 'unauthorized' }, 401)

  const runRows = (await db.execute(sql`
    SELECT id, status, account_id
      FROM public.cloud_runs
     WHERE id = ${runId} AND workspace_id = ${ws}
     LIMIT 1
  `)) as unknown as Array<{ id: string; status: string; account_id: string }>
  if (runRows.length === 0) return c.json({ error: 'not_found' }, 404)

  const run = runRows[0]!
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return c.json({
      runId,
      cancelled: false,
      runStatus: run.status,
      reason: 'already_terminal',
    }, 200)
  }

  // Look up the active binding (if any). Order by created_at DESC so retries
  // pick the latest if there's somehow more than one.
  const bindingRows = (await db.execute(sql`
    SELECT session_id, pool_id
      FROM public.cloud_session_bindings
     WHERE run_id = ${runId} AND ended_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
  `)) as unknown as Array<{ session_id: string; pool_id: string | null }>

  if (bindingRows.length === 0 || !bindingRows[0]!.pool_id) {
    // State (2): pending. No pool to notify; flip status + emit activity so
    // the SSE stream terminates and the dispatcher skips on late delivery.
    await db.execute(sql`
      UPDATE public.cloud_runs
         SET status = 'cancelled',
             completed_at = now()
       WHERE id = ${runId} AND workspace_id = ${ws}
    `)
    await db.execute(sql`
      INSERT INTO public.cloud_activity
        (agent_run_id, workspace_id, account_id, activity_type, payload)
      VALUES
        (${runId}, ${ws}, ${run.account_id}, 'run_cancelled',
         ${JSON.stringify({
           reason: 'cancelled_before_dispatch',
           cancelledAt: new Date().toISOString(),
         })}::jsonb)
    `)
    return c.json({
      runId,
      cancelled: true,
      runStatus: 'cancelled',
      via: 'pre_dispatch',
    }, 200)
  }

  // State (3): running. NOTIFY the pool's channel with a cancel message.
  // The pool host's listener picks up `kind:'cancel'` and DELETEs the session.
  const binding = bindingRows[0]!
  const channel = poolChannelName(binding.pool_id!)
  const payload = JSON.stringify({
    kind: 'cancel',
    sessionId: binding.session_id,
    runId,
  })
  await db.execute(sql`SELECT pg_notify(${channel}, ${payload})`)

  return c.json({
    runId,
    cancelled: true,
    runStatus: 'cancelling',
    via: 'pool_notify',
    sessionId: binding.session_id,
    poolId: binding.pool_id,
  }, 202)
})

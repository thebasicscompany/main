/**
 * Cloud-agent control-plane (Phase H follow-up).
 *
 *   POST /v1/runs                                  — dispatch a one-shot run via SQS
 *   GET  /v1/runs?cloudAgentId=…&limit=&since=     — list past runs for a cloud_agent
 *   GET  /v1/runs/:id/events                       — SSE stream of agent_activity
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
import { randomUUID } from 'node:crypto'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

export const cloudRunsRoute = new Hono<{ Variables: Vars }>()

const UUID_RE = /^[0-9a-fA-F-]{36}$/
let _sqs: SQSClient | null = null
function sqsClient(): SQSClient {
  if (!_sqs) _sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  return _sqs
}

const TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_cancelled'])

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
    const ws = c.var.workspace!.workspace_id
    const acc = c.var.workspace!.account_id
    const body = c.req.valid('json')

    let cloudAgentId = body.cloudAgentId
    if (cloudAgentId) {
      // Verify the cloud_agent belongs to this workspace.
      const rows = (await db.execute(sql`
        SELECT id FROM public.cloud_agents
         WHERE id = ${cloudAgentId} AND workspace_id = ${ws}
         LIMIT 1
      `)) as unknown as Array<{ id: string }>
      if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
    } else {
      // Pick (or create) an "ad-hoc" cloud_agent for this workspace.
      const existing = (await db.execute(sql`
        SELECT id FROM public.cloud_agents
         WHERE workspace_id = ${ws} AND agent_id = 'ad-hoc'
         LIMIT 1
      `)) as unknown as Array<{ id: string }>
      if (existing.length > 0) {
        cloudAgentId = existing[0]!.id
      } else {
        const created = (await db.execute(sql`
          INSERT INTO public.cloud_agents
            (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
          VALUES
            (${ws}, ${acc}, 'ad-hoc', 'One-shot runs dispatched via POST /v1/runs',
             'manual', 'active', ${ws}, 'harness')
          RETURNING id
        `)) as unknown as Array<{ id: string }>
        cloudAgentId = created[0]!.id
      }
    }

    const runId = randomUUID()
    await db.execute(sql`
      INSERT INTO public.cloud_runs
        (id, cloud_agent_id, workspace_id, account_id, status, run_mode)
      VALUES
        (${runId}, ${cloudAgentId}, ${ws}, ${acc}, 'pending', 'live')
    `)

    const cfg = getConfig()
    const queueUrl = cfg.RUNS_QUEUE_URL
    if (!queueUrl) {
      return c.json({ error: 'runs_queue_not_configured' }, 503)
    }
    const groupId = `${ws}:${body.laneId ?? 'default'}`
    await sqsClient().send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        runId, workspaceId: ws, accountId: acc,
        goal: body.goal,
        ...(body.model ? { model: body.model } : {}),
      }),
      MessageGroupId: groupId,
      MessageDeduplicationId: runId,
    }))

    return c.json({ runId, status: 'pending', cloudAgentId, liveViewUrl: null }, 201)
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

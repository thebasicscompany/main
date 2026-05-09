/**
 * Cloud-agent run SSE proxy. CLOUD-AGENT-PLAN §11.1 / BUILD-LOOP A.9 verify #5.
 *
 *   GET /v1/runs/:id/events  →  text/event-stream
 *
 * Subscribes to Supabase Realtime for `agent_activity` rows tagged with the
 * given `agent_run_id` and re-emits each as an SSE event whose name matches
 * the row's `activity_type` column. The client gets the canonical §11.1
 * sequence (`run_started`, `tool_call_start`, `tool_call_end`, `screenshot`,
 * `run_completed`, …) live as the worker writes them.
 *
 * Mounted publicly for slice 3's smoke test. Production auth (workspace JWT
 * + workspace_id check) lands when the desktop app starts consuming this
 * endpoint — see app.ts mount comment.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createClient } from '@supabase/supabase-js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'

export const cloudRunsRoute = new Hono()

const TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_cancelled'])

cloudRunsRoute.get('/:id/events', async (c) => {
  const runId = c.req.param('id')
  if (!/^[0-9a-fA-F-]{36}$/.test(runId)) {
    return c.json({ error: 'invalid_run_id' }, 400)
  }

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
      .from('agent_activity')
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
      .channel(`agent_activity:${runId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_activity',
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

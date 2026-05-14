/**
 * G.3 — Workspace-scoped outputs SSE stream.
 *
 *   GET /v1/workspaces/:wsId/outputs/stream
 *
 * Subscribes to Supabase Realtime on `public.cloud_activity` filtered
 * to `workspace_id=eq.<wsId>`, then forwards every INSERT whose
 * activity_type is `output_dispatched` or `output_failed` as an
 * `event: output` frame. Desktop renders these as toast notifications
 * independent of any specific run view (the SSE in cloud-runs.ts is
 * keyed by run_id; this one fans in across the whole workspace).
 *
 * No hydrate frame — outputs are time-sensitive notifications, not
 * state the client needs to "catch up on". The cloud_activity table
 * is INSERT-only so we don't need UPDATE/DELETE forwarding.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

const KEEPALIVE_INTERVAL_MS = 25_000

const OUTPUT_ACTIVITY_TYPES = new Set(['output_dispatched', 'output_failed'])

/** Test seam — allow tests to substitute a mock Supabase client. */
let _supabaseFactoryForTests: (() => SupabaseClient | null) | null = null
export function setSupabaseFactoryForOutputsTests(fn: (() => SupabaseClient | null) | null): void {
  _supabaseFactoryForTests = fn
}

export const outputsSseRoute = new Hono<{ Variables: Vars }>()

outputsSseRoute.get('/:wsId/outputs/stream', async (c) => {
  const pathWsId = c.req.param('wsId')
  const jwtWsId = c.var.workspace?.workspace_id
  if (!jwtWsId || pathWsId !== jwtWsId) {
    return c.json({ error: 'workspace_mismatch' }, 403)
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

    const supabase: SupabaseClient = _supabaseFactoryForTests
      ? (_supabaseFactoryForTests() as SupabaseClient)
      : createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 50 } },
        })

    let closed = false

    async function emit(row: {
      id?: string
      agent_run_id?: string
      activity_type?: string
      payload?: Record<string, unknown> | null
      created_at?: string
    }): Promise<void> {
      if (closed) return
      if (!row.activity_type || !OUTPUT_ACTIVITY_TYPES.has(row.activity_type)) return
      const p = row.payload ?? {}
      // Field shape (per shared/src/activity.ts):
      //   output_dispatched payload: { kind, channel, recipient_or_key,
      //     content_hash, attempt, latency_ms }
      //   output_failed payload: { kind, channel, error:{code,message},
      //     retriable }  — NO recipient field on the failed branch.
      // We also tolerate legacy `to`/`recipient` keys so a future
      // schema rename (or a custom event source) doesn't silently
      // drop the recipient.
      const recipient =
        (p.recipient_or_key as string | undefined) ??
        (p.to as string | undefined) ??
        (p.recipient as string | undefined)
      const frame: Record<string, unknown> = {
        run_id: row.agent_run_id,
        kind: row.activity_type, // 'output_dispatched' | 'output_failed'
        channel: p.channel,
        status: row.activity_type === 'output_failed' ? 'failed' : 'dispatched',
        dispatched_at: row.created_at,
      }
      if (recipient) frame.to = recipient
      if (row.activity_type === 'output_failed') {
        // OutputFailedEventSchema.error is { code, message }; surface
        // a flat string so the toast can render "email failed: <msg>".
        const err = p.error as { code?: string; message?: string } | string | undefined
        if (typeof err === 'string') frame.error = err
        else if (err && typeof err === 'object') {
          frame.error = err.message ?? err.code ?? 'unknown'
        }
      }
      await stream.writeSSE({
        id: row.id,
        event: 'output',
        data: JSON.stringify(frame),
      })
    }

    // Supabase Realtime filters support equality only — subscribe to
    // ALL cloud_activity rows for this workspace, then filter
    // activity_type in the JS callback (cheap; activity_type is a
    // small text field).
    const channel = supabase
      .channel(`outputs:${pathWsId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'cloud_activity',
          filter: `workspace_id=eq.${pathWsId}`,
        },
        async (payload: { new: Record<string, unknown> }) => emit(payload.new as never),
      )
      .subscribe()

    // Emit a tiny `ready` frame so test clients (and desktop) can tell
    // the subscription is live before any output event fires. Mirrors
    // the convention of "first frame = state signal" used in G.1.
    await stream.writeSSE({ event: 'ready', data: JSON.stringify({ workspace_id: pathWsId }) })

    // Hold the connection open + keepalive.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true
        supabase.removeChannel(channel).catch(() => undefined)
        resolve()
      })
      const keepalive = setInterval(async () => {
        if (closed) {
          clearInterval(keepalive)
          return
        }
        try {
          await stream.write(': keep-alive\n\n')
        } catch (e) {
          logger.warn({ wsId: pathWsId, err: (e as Error).message }, 'outputs-sse keep-alive write failed')
          closed = true
          clearInterval(keepalive)
          supabase.removeChannel(channel).catch(() => undefined)
          resolve()
        }
      }, KEEPALIVE_INTERVAL_MS)
    })
  })
})

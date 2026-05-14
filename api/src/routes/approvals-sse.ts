/**
 * G.1 — Workspace-scoped pending-approvals SSE stream.
 *
 *   GET /v1/workspaces/:wsId/approvals/stream
 *
 * On connect:
 *   1. Authenticate (workspace JWT via the /v1/workspaces/* middleware
 *      in app.ts) and confirm `:wsId === jwt.workspace_id`.
 *   2. Emit one `event: hydrate` frame with the current list of
 *      `status='pending'` approvals scoped to this workspace.
 *   3. Subscribe to Supabase Realtime on `public.approvals` filtered
 *      to `workspace_id=eq.<wsId>` for INSERT (new pending), UPDATE
 *      (decided/expired) and DELETE events. Forward each as an
 *      `event: approval` frame with the row's public shape.
 *   4. Send a `: keep-alive` comment frame every 25 seconds so
 *      intermediaries (NLBs, browser EventSource buffering) don't
 *      consider the stream idle.
 *
 * The desktop opens this stream once per workspace and routes
 * pending approvals into its own UI. It also opens
 * /v1/workspaces/:wsId/outputs/stream (G.3) for output_dispatched
 * fanout.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

const KEEPALIVE_INTERVAL_MS = 25_000

/** Test seam — allow tests to substitute a mock Supabase client. */
let _supabaseFactoryForTests: (() => SupabaseClient | null) | null = null
export function setSupabaseFactoryForTests(fn: (() => SupabaseClient | null) | null): void {
  _supabaseFactoryForTests = fn
}

export const approvalsSseRoute = new Hono<{ Variables: Vars }>()

interface ApprovalPublic {
  id: string
  run_id: string
  workspace_id: string
  account_id?: string | null
  tool_name: string | null
  tool_call_id: string | null
  args_preview: unknown
  args_hash: string | null
  reason: string | null
  status: string
  decided_by: string | null
  decided_at: string | null
  expires_at: string | null
  created_at: string
}

approvalsSseRoute.get('/:wsId/approvals/stream', async (c) => {
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

    // Hydrate: current pending approvals for this workspace.
    const hydrate = (await db.execute(sql`
      SELECT id::text AS id,
             run_id::text AS run_id,
             workspace_id::text AS workspace_id,
             tool_name,
             tool_call_id,
             args_preview,
             args_hash,
             reason,
             status,
             decided_by::text AS decided_by,
             decided_at::text AS decided_at,
             expires_at::text AS expires_at,
             created_at::text AS created_at
        FROM public.approvals
       WHERE workspace_id = ${pathWsId}
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 200
    `)) as unknown as Array<ApprovalPublic>

    // Register realtime listeners BEFORE writing the hydrate frame so
    // there's no observable window where new approvals could be missed
    // (an INSERT during the hydrate query would otherwise slip through
    // the gap). Side benefit: tests can rely on listeners-present
    // once they've seen the hydrate event.
    const supabase: SupabaseClient = _supabaseFactoryForTests
      ? (_supabaseFactoryForTests() as SupabaseClient)
      : createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 50 } },
        })

    let closed = false

    async function emit(op: 'INSERT' | 'UPDATE' | 'DELETE', row: Record<string, unknown> | null): Promise<void> {
      if (closed || !row) return
      // Strip the access_token_hash before forwarding to clients —
      // it's a secret derivative.
      const safe: Record<string, unknown> = { ...row }
      delete safe.access_token_hash
      await stream.writeSSE({
        id: typeof row.id === 'string' ? row.id : undefined,
        event: 'approval',
        data: JSON.stringify({ op, approval: safe }),
      })
    }

    const channel = supabase
      .channel(`approvals:${pathWsId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'approvals',
          filter: `workspace_id=eq.${pathWsId}`,
        },
        async (payload: { new: Record<string, unknown> }) => emit('INSERT', payload.new),
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'approvals',
          filter: `workspace_id=eq.${pathWsId}`,
        },
        async (payload: { new: Record<string, unknown> }) => emit('UPDATE', payload.new),
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'DELETE',
          schema: 'public',
          table: 'approvals',
          filter: `workspace_id=eq.${pathWsId}`,
        },
        async (payload: { old: Record<string, unknown> }) => emit('DELETE', payload.old),
      )
      .subscribe()

    // Now emit hydrate. Listeners are registered, so any INSERT
    // happening between this point and the next sweep arrives via the
    // realtime callback above (not lost).
    await stream.writeSSE({
      event: 'hydrate',
      data: JSON.stringify({ approvals: hydrate }),
    })

    // Hold the SSE connection open until the client disconnects.
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
          // SSE comment frame — no event, just bytes to keep
          // intermediaries from idling out the connection.
          await stream.write(': keep-alive\n\n')
        } catch (e) {
          logger.warn({ wsId: pathWsId, err: (e as Error).message }, 'approvals-sse keep-alive write failed')
          closed = true
          clearInterval(keepalive)
          supabase.removeChannel(channel).catch(() => undefined)
          resolve()
        }
      }, KEEPALIVE_INTERVAL_MS)
    })
  })
})

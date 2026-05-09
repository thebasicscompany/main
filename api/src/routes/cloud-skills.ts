/**
 * /v1/skills — cloud-agent skill review surface (Phase H follow-up).
 *
 * Skills are written by the worker via the `skill_write` tool with
 * `pending_review = true`. The worker's loader filters out unapproved
 * rows so skills are invisible to the LLM until an operator approves.
 *
 * Routes (all require workspace JWT):
 *   GET    /v1/skills                  — list skills (filter ?pending=true)
 *   POST   /v1/skills/:id/approve      — flip pending_review=false
 *   POST   /v1/skills/:id/reject       — flip active=false
 *   PATCH  /v1/skills/:id              — edit description/body/confidence
 *   DELETE /v1/skills/:id              — soft delete (active=false)
 *
 * All scoped to `workspace_id = <token.workspace_id>`. Cross-workspace
 * lookups return 404 to avoid existence leaks.
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const cloudSkillsRoute = new Hono<{ Variables: Vars }>()

const UUID_RE = /^[0-9a-fA-F-]{36}$/

interface SkillRow {
  id: string
  workspace_id: string
  name: string
  description: string
  body: string
  host: string | null
  scope: string
  confidence: string
  active: boolean
  pending_review: boolean
  superseded_by: string | null
  created_at: string
  updated_at: string
}

cloudSkillsRoute.get(
  '/',
  zValidator('query', z.object({
    pending: z.enum(['true', 'false']).optional(),
    host: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })),
  async (c) => {
    const ws = c.var.workspace.workspace_id
    const q = c.req.valid('query')
    const result = await db.execute(sql`
      SELECT id, workspace_id, name, description, body, host, scope,
             confidence::text AS confidence, active, pending_review,
             superseded_by, created_at::text AS created_at, updated_at::text AS updated_at
      FROM public.cloud_skills
      WHERE workspace_id = ${ws}
        AND active = true
        ${q.pending === 'true' ? sql`AND pending_review = true` : sql``}
        ${q.pending === 'false' ? sql`AND pending_review = false` : sql``}
        ${q.host ? sql`AND host = ${q.host}` : sql``}
      ORDER BY created_at DESC
      LIMIT ${q.limit}
    `)
    return c.json({ skills: result as unknown as SkillRow[] })
  },
)

cloudSkillsRoute.post('/:id/approve', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace.workspace_id
  const rows = (await db.execute(sql`
    UPDATE public.cloud_skills
       SET pending_review = false, updated_at = now()
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING id, pending_review
  `)) as unknown as Array<{ id: string; pending_review: boolean }>
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: rows[0]!.id, pending_review: rows[0]!.pending_review })
})

cloudSkillsRoute.post('/:id/reject', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace.workspace_id
  const rows = (await db.execute(sql`
    UPDATE public.cloud_skills
       SET active = false, updated_at = now()
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING id, active
  `)) as unknown as Array<{ id: string; active: boolean }>
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: rows[0]!.id, active: rows[0]!.active })
})

cloudSkillsRoute.patch(
  '/:id',
  zValidator('json', z.object({
    description: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(64 * 1024).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })),
  async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
    const ws = c.var.workspace.workspace_id
    const patch = c.req.valid('json')
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'invalid_request', detail: 'at least one field required' }, 400)
    }
    const setClauses: ReturnType<typeof sql>[] = []
    if (patch.description !== undefined) setClauses.push(sql`description = ${patch.description}`)
    if (patch.body !== undefined) setClauses.push(sql`body = ${patch.body}`)
    if (patch.confidence !== undefined) setClauses.push(sql`confidence = ${patch.confidence}`)
    setClauses.push(sql`updated_at = now()`)
    const setSql = sql.join(setClauses, sql`, `)
    const rows = (await db.execute(sql`
      UPDATE public.cloud_skills
         SET ${setSql}
       WHERE id = ${id} AND workspace_id = ${ws}
       RETURNING id
    `)) as unknown as Array<{ id: string }>
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
    return c.json({ id: rows[0]!.id, updated: true })
  },
)

cloudSkillsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace.workspace_id
  const rows = (await db.execute(sql`
    UPDATE public.cloud_skills
       SET active = false, updated_at = now()
     WHERE id = ${id} AND workspace_id = ${ws}
     RETURNING id, active
  `)) as unknown as Array<{ id: string; active: boolean }>
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: rows[0]!.id, deleted: true })
})

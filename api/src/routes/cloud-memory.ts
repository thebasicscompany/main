import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WorkspaceToken } from '../lib/jwt.js'
import { getCloudMemoryRepo, type CloudMemoryItem } from '../orchestrator/cloudMemoryRepo.js'
import { getDesktopAssistantsRepo } from '../orchestrator/desktopAssistantsRepo.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const cloudMemoryRoute = new Hono<{ Variables: Vars }>()

const VALID_KINDS = [
  'episodic',
  'semantic',
  'procedural',
  'emotional',
  'prospective',
  'behavioral',
  'narrative',
  'shared',
] as const

const VALID_STATUSES = ['active', 'superseded', 'archived', 'all'] as const
const VALID_SORTS = ['lastSeenAt', 'importance', 'kind', 'firstSeenAt'] as const
const VALID_ORDERS = ['asc', 'desc'] as const

const createMemoryItemSchema = z
  .object({
    kind: z.enum(VALID_KINDS),
    subject: z.string().min(1).max(512),
    statement: z.string().min(1).max(20_000),
    importance: z.number().min(0).max(1).nullable().optional(),
  })
  .strict()

const updateMemoryItemSchema = z
  .object({
    kind: z.enum(VALID_KINDS).optional(),
    subject: z.string().min(1).max(512).optional(),
    statement: z.string().min(1).max(20_000).optional(),
    status: z.enum(['active', 'superseded', 'archived']).optional(),
    importance: z.number().min(0).max(1).nullable().optional(),
    verificationState: z.string().max(128).nullable().optional(),
  })
  .strict()

const conceptPageSchema = z
  .object({
    slug: z.string().min(1).max(512),
  })
  .strict()

function invalidRequest(
  result: { success: false; error: Parameters<typeof z.flattenError>[0] },
  c: { json: (body: unknown, status: 400) => Response },
) {
  return c.json(
    {
      error: 'invalid_request',
      code: 'validation_failed',
      issues: z.flattenError(result.error),
    },
    400,
  )
}

async function requireAssistant(workspaceId: string, assistantId: string) {
  return getDesktopAssistantsRepo().get(workspaceId, assistantId)
}

function timestampMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : null
}

function serializeMemoryItem(item: CloudMemoryItem) {
  return {
    id: item.id,
    kind: item.kind,
    subject: item.subject,
    statement: item.statement,
    status: item.status,
    confidence: item.confidence,
    importance: item.importance,
    firstSeenAt: timestampMs(item.firstSeenAt) ?? Date.now(),
    lastSeenAt: timestampMs(item.lastSeenAt) ?? Date.now(),
    fidelity: item.metadata.fidelity ?? null,
    sourceType: item.metadata.sourceType ?? 'direct',
    narrativeRole: item.metadata.narrativeRole ?? null,
    partOfStory: item.metadata.partOfStory ?? null,
    reinforcementCount: item.metadata.reinforcementCount ?? null,
    stability: item.metadata.stability ?? null,
    emotionalCharge: item.metadata.emotionalCharge ?? null,
    accessCount: null,
    verificationState: item.verificationState,
    scopeId: item.assistantId,
    scopeLabel: null,
    lastUsedAt: null,
    supersedes: null,
    supersededBy: null,
    supersedesSubject: null,
    supersededBySubject: null,
  }
}

function parseInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

async function handleListMemoryItems(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: {
    param: (key: 'assistantId') => string
    query: (key: string) => string | undefined
  }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)

  const kind = c.req.query('kind')
  if (kind && !VALID_KINDS.includes(kind as (typeof VALID_KINDS)[number])) {
    return c.json({ error: 'invalid_request', message: 'invalid kind' }, 400)
  }
  const status = c.req.query('status') ?? 'active'
  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    return c.json({ error: 'invalid_request', message: 'invalid status' }, 400)
  }
  const sort = c.req.query('sort') ?? 'lastSeenAt'
  if (!VALID_SORTS.includes(sort as (typeof VALID_SORTS)[number])) {
    return c.json({ error: 'invalid_request', message: 'invalid sort' }, 400)
  }
  const order = c.req.query('order') ?? 'desc'
  if (!VALID_ORDERS.includes(order as (typeof VALID_ORDERS)[number])) {
    return c.json({ error: 'invalid_request', message: 'invalid order' }, 400)
  }
  const limit = Math.min(250, Math.max(1, parseInteger(c.req.query('limit'), 100)))
  const offset = Math.max(0, parseInteger(c.req.query('offset'), 0))

  const result = await getCloudMemoryRepo().listItems({
    workspaceId: workspace.workspace_id,
    assistantId,
    kind: kind || undefined,
    status,
    search: c.req.query('search') || undefined,
    sort: sort as (typeof VALID_SORTS)[number],
    order: order as (typeof VALID_ORDERS)[number],
    limit,
    offset,
  })
  return c.json(
    {
      items: result.items.map(serializeMemoryItem),
      total: result.total,
      kindCounts: result.kindCounts,
    },
    200,
  )
}

cloudMemoryRoute.get('/:assistantId/memory-items', handleListMemoryItems)
cloudMemoryRoute.get('/:assistantId/memory-items/', handleListMemoryItems)

async function handleGetMemoryItem(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId' | 'id') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const item = await getCloudMemoryRepo().getItem({
    workspaceId: workspace.workspace_id,
    assistantId,
    id: c.req.param('id'),
  })
  if (!item) return c.json({ detail: 'Memory item not found' }, 404)
  return c.json({ item: serializeMemoryItem(item) }, 200)
}

cloudMemoryRoute.get('/:assistantId/memory-items/:id', handleGetMemoryItem)
cloudMemoryRoute.get('/:assistantId/memory-items/:id/', handleGetMemoryItem)

async function handleCreateMemoryItem(c: any) {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    const body = c.req.valid('json')
    const item = await getCloudMemoryRepo().createItem({
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      assistantId,
      kind: body.kind,
      subject: body.subject,
      statement: body.statement,
      importance: body.importance ?? null,
    })
    return c.json({ item: serializeMemoryItem(item) }, 201)
}

cloudMemoryRoute.post(
  '/:assistantId/memory-items',
  zValidator('json', createMemoryItemSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  handleCreateMemoryItem,
)
cloudMemoryRoute.post(
  '/:assistantId/memory-items/',
  zValidator('json', createMemoryItemSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  handleCreateMemoryItem,
)

async function handleUpdateMemoryItem(c: any) {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    const body = c.req.valid('json')
    const item = await getCloudMemoryRepo().updateItem({
      workspaceId: workspace.workspace_id,
      assistantId,
      id: c.req.param('id'),
      kind: body.kind,
      subject: body.subject,
      statement: body.statement,
      status: body.status,
      importance: body.importance,
      verificationState: body.verificationState,
    })
    if (!item) return c.json({ detail: 'Memory item not found' }, 404)
    return c.json({ item: serializeMemoryItem(item) }, 200)
}

cloudMemoryRoute.patch(
  '/:assistantId/memory-items/:id',
  zValidator('json', updateMemoryItemSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  handleUpdateMemoryItem,
)
cloudMemoryRoute.patch(
  '/:assistantId/memory-items/:id/',
  zValidator('json', updateMemoryItemSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  handleUpdateMemoryItem,
)

async function handleDeleteMemoryItem(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId' | 'id') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const deleted = await getCloudMemoryRepo().deleteItem({
    workspaceId: workspace.workspace_id,
    assistantId,
    id: c.req.param('id'),
  })
  if (!deleted) return c.json({ detail: 'Memory item not found' }, 404)
  return new Response(null, { status: 204 })
}

cloudMemoryRoute.delete('/:assistantId/memory-items/:id', handleDeleteMemoryItem)
cloudMemoryRoute.delete('/:assistantId/memory-items/:id/', handleDeleteMemoryItem)

async function handleListConceptPages(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistantId = c.req.param('assistantId')
  const assistant = await requireAssistant(workspace.workspace_id, assistantId)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const pages = await getCloudMemoryRepo().listConceptPages({
    workspaceId: workspace.workspace_id,
    assistantId,
  })
  return c.json(
    {
      pages: pages.map((page) => ({
        slug: page.slug,
        bodyBytes: page.bodyBytes,
        edgeCount: page.edgeCount,
        updatedAtMs: timestampMs(page.updatedAt) ?? Date.now(),
      })),
    },
    200,
  )
}

cloudMemoryRoute.post(
  '/:assistantId/memory/v2/list-concept-pages',
  handleListConceptPages,
)
cloudMemoryRoute.post(
  '/:assistantId/memory/v2/list-concept-pages/',
  handleListConceptPages,
)

async function handleGetConceptPage(c: any) {
    const workspace = c.get('workspace')
    const assistantId = c.req.param('assistantId')
    const assistant = await requireAssistant(workspace.workspace_id, assistantId)
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    const page = await getCloudMemoryRepo().getConceptPage({
      workspaceId: workspace.workspace_id,
      assistantId,
      slug: c.req.valid('json').slug,
    })
    if (!page) return c.json({ detail: 'Concept page not found' }, 404)
    return c.json({ slug: page.slug, rendered: page.rendered }, 200)
}

cloudMemoryRoute.post(
  '/:assistantId/memory/v2/concept-page',
  zValidator('json', conceptPageSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  handleGetConceptPage,
)
cloudMemoryRoute.post(
  '/:assistantId/memory/v2/concept-page/',
  zValidator('json', conceptPageSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  handleGetConceptPage,
)

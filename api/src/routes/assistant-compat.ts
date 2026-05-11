import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WorkspaceToken } from '../lib/jwt.js'
import {
  listWorkspaceFiles,
  resolveAssistantWorkspacePath,
  WorkspacePathError,
  workspaceEntry,
  workspaceTree,
} from '../lib/workspace-files.js'
import { logger } from '../middleware/logger.js'
import {
  getAssistantCompatRepo,
  type CompatApp,
  type CompatDocument,
  type CompatRoutine,
  type CompatScope,
} from '../orchestrator/assistantCompatRepo.js'
import { getDesktopAssistantsRepo } from '../orchestrator/desktopAssistantsRepo.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const assistantCompatRoute = new Hono<{ Variables: Vars }>()

const DEFAULT_PRIVACY = {
  collectUsageData: true,
  sendDiagnostics: true,
  llmRequestLogRetentionMs: null as number | null,
}

const DEFAULT_THRESHOLDS = {
  interactive: 'none',
  autonomous: 'none',
  headless: 'none',
}

const CONFIG_DEFAULTS = {
  llm: {},
  privacy: DEFAULT_PRIVACY,
}

const COMMON_FLAGS = [
  {
    key: 'conversation-starters',
    enabled: true,
    defaultEnabled: true,
    label: 'Conversation Starters',
    description: 'Show starter prompts in chat.',
  },
  {
    key: 'browser',
    enabled: true,
    defaultEnabled: true,
    label: 'Browser',
    description: 'Allow browser-assisted work.',
  },
  {
    key: 'ces-tools',
    enabled: true,
    defaultEnabled: true,
    label: 'Computer Tools',
    description: 'Allow host-computer tools where supported.',
  },
]

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional(),
})

const pathSchema = z.object({ path: z.string().min(1) })
const renameSchema = z.object({ oldPath: z.string().min(1), newPath: z.string().min(1) })
const privacyPatchSchema = z.object({
  collectUsageData: z.boolean().optional(),
  sendDiagnostics: z.boolean().optional(),
  llmRequestLogRetentionMs: z.number().int().nonnegative().nullable().optional(),
})
const flagPatchSchema = z.object({ enabled: z.boolean() })
const thresholdsSchema = z.object({
  interactive: z.string().optional(),
  autonomous: z.string().optional(),
  headless: z.string().optional(),
})
const conversationThresholdSchema = z.object({ threshold: z.string() })
const documentSaveSchema = z.object({
  surfaceId: z.string().min(1),
  conversationId: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  wordCount: z.number().int().nonnegative().default(0),
})
const appCreateSchema = z.object({
  id: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
  conversationId: z.string().nullable().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  html: z.string().optional(),
  version: z.string().nullable().optional(),
  contentId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
const previewSchema = z.object({ preview: z.string() })
const routineCreateSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  sourceKind: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
const routinePatchSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

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

function timestampMs(iso: string | null | undefined) {
  if (!iso) return null
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : null
}

type CompatContext = Context<{ Variables: Vars }, string, any>

async function requireAssistantScope(c: CompatContext) {
  const workspace = c.get('workspace') as WorkspaceToken
  const assistantId = c.req.param('assistantId') ?? ''
  const assistant = await getDesktopAssistantsRepo().get(
    workspace.workspace_id,
    assistantId,
  )
  if (!assistant) return null
  return {
    workspace,
    assistant,
    scope: {
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      assistantId,
    },
  }
}

async function withScope(
  c: CompatContext,
  family: string,
  fn: (input: { workspace: WorkspaceToken; scope: CompatScope }) => Promise<Response>,
) {
  const requestId = c.get('requestId')
  const found = await requireAssistantScope(c)
  if (!found) {
    logger.info(
      {
        requestId,
        assistant_id: c.req.param('assistantId'),
        route_family: family,
        status: 404,
        missing_resource: 'assistant',
      },
      'assistant compatibility route missing resource',
    )
    return c.json({ detail: 'Assistant not found' }, 404)
  }
  const res = await fn({ workspace: found.workspace, scope: found.scope })
  logger.info(
    {
      requestId,
      workspace_id: found.workspace.workspace_id,
      assistant_id: found.scope.assistantId,
      route_family: family,
      status: res.status,
    },
    'assistant compatibility route handled',
  )
  return res
}

function jsonScopeData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function mergedSetting(scope: CompatScope, key: string, defaults: Record<string, unknown>) {
  const data = await getAssistantCompatRepo().getSetting(scope, key)
  return { ...defaults, ...data }
}

function serializeDoc(doc: CompatDocument) {
  return {
    surfaceId: doc.surfaceId,
    conversationId: doc.conversationId,
    title: doc.title,
    content: doc.content,
    wordCount: doc.wordCount,
    createdAt: timestampMs(doc.createdAt) ?? Date.now(),
    updatedAt: timestampMs(doc.updatedAt) ?? Date.now(),
  }
}

function serializeDocList(doc: CompatDocument) {
  const { content: _content, ...rest } = serializeDoc(doc)
  return rest
}

function serializeApp(app: CompatApp) {
  return {
    id: app.appId,
    appId: app.appId,
    name: app.name,
    description: app.description,
    icon: app.icon,
    preview: app.preview,
    createdAt: timestampMs(app.createdAt) ?? Date.now(),
    version: app.version,
    contentId: app.contentId,
  }
}

function serializeRoutine(routine: CompatRoutine) {
  return {
    id: routine.id,
    title: routine.title,
    status: routine.status,
    sourceKind: routine.sourceKind,
    lensSessionId: routine.lensSessionId,
    extensionRecordingId: routine.extensionRecordingId,
    startedAt: timestampMs(routine.startedAt),
    stoppedAt: timestampMs(routine.stoppedAt),
    createdAt: timestampMs(routine.createdAt) ?? Date.now(),
    updatedAt: timestampMs(routine.updatedAt) ?? Date.now(),
    metadata: routine.metadata,
  }
}

function disabledAction(routineId: string, nextPhase: string) {
  return {
    ok: false,
    code: 'cloud_action_not_enabled',
    routineId,
    message: 'Cloud routine execution is not enabled for this routine yet.',
    nextPhase,
  }
}

function workspaceError(c: { json: (body: unknown, status?: number) => Response }, err: unknown) {
  if (err instanceof WorkspacePathError) {
    return c.json({ error: 'invalid_path', message: err.message }, err.status)
  }
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
    return c.json({ error: 'not_found' }, 404)
  }
  throw err
}

assistantCompatRoute.get('/:assistantId/config', (c) =>
  withScope(c, 'config', async ({ scope }) => {
    const config = await mergedSetting(scope, 'config', CONFIG_DEFAULTS)
    return c.json(config, 200)
  }),
)
assistantCompatRoute.get('/:assistantId/config/', (c) =>
  withScope(c, 'config', async ({ scope }) => {
    const config = await mergedSetting(scope, 'config', CONFIG_DEFAULTS)
    return c.json(config, 200)
  }),
)
assistantCompatRoute.patch('/:assistantId/config', async (c) =>
  withScope(c, 'config', async ({ scope }) => {
    const patch = jsonScopeData(await c.req.json().catch(() => ({})))
    const current = await mergedSetting(scope, 'config', CONFIG_DEFAULTS)
    const next = { ...current, ...patch }
    await getAssistantCompatRepo().setSetting(scope, 'config', next)
    return c.json(next, 200)
  }),
)

assistantCompatRoute.get('/:assistantId/config/llm/call-sites', (c) =>
  withScope(c, 'config', async () =>
    c.json({ callSites: [], profiles: [], activeProfile: null }, 200),
  ),
)
assistantCompatRoute.get('/:assistantId/config/llm/call-sites/', (c) =>
  withScope(c, 'config', async () =>
    c.json({ callSites: [], profiles: [], activeProfile: null }, 200),
  ),
)

assistantCompatRoute.get('/:assistantId/config/privacy', (c) =>
  withScope(c, 'privacy', async ({ scope }) => {
    const privacy = await mergedSetting(scope, 'privacy', DEFAULT_PRIVACY)
    return c.json(privacy, 200)
  }),
)
assistantCompatRoute.patch(
  '/:assistantId/config/privacy',
  zValidator('json', privacyPatchSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'privacy', async ({ scope }) => {
      const current = await mergedSetting(scope, 'privacy', DEFAULT_PRIVACY)
      const next = { ...current, ...c.req.valid('json') }
      await getAssistantCompatRepo().setSetting(scope, 'privacy', next)
      return c.json(next, 200)
    }),
)

assistantCompatRoute.get('/:assistantId/feature-flags', (c) =>
  withScope(c, 'feature-flags', async ({ scope }) => {
    const overrides = await getAssistantCompatRepo().getSetting(scope, 'feature-flags')
    const flags = COMMON_FLAGS.map((flag) => ({
      ...flag,
      enabled:
        typeof overrides[flag.key] === 'boolean'
          ? (overrides[flag.key] as boolean)
          : flag.defaultEnabled,
    }))
    return c.json({ flags }, 200)
  }),
)
assistantCompatRoute.patch(
  '/:assistantId/feature-flags/:key',
  zValidator('json', flagPatchSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'feature-flags', async ({ scope }) => {
      const current = await getAssistantCompatRepo().getSetting(scope, 'feature-flags')
      const next = { ...current, [c.req.param('key')]: c.req.valid('json').enabled }
      await getAssistantCompatRepo().setSetting(scope, 'feature-flags', next)
      return c.json({ key: c.req.param('key'), enabled: c.req.valid('json').enabled }, 200)
    }),
)

assistantCompatRoute.get('/:assistantId/permissions/thresholds', (c) =>
  withScope(c, 'permissions', async ({ scope }) => {
    const thresholds = await mergedSetting(scope, 'permissions-thresholds', DEFAULT_THRESHOLDS)
    return c.json(thresholds, 200)
  }),
)
assistantCompatRoute.put(
  '/:assistantId/permissions/thresholds',
  zValidator('json', thresholdsSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'permissions', async ({ scope }) => {
      const current = await mergedSetting(scope, 'permissions-thresholds', DEFAULT_THRESHOLDS)
      const next = { ...current, ...c.req.valid('json') }
      await getAssistantCompatRepo().setSetting(scope, 'permissions-thresholds', next)
      return c.json(next, 200)
    }),
)

assistantCompatRoute.get('/:assistantId/permissions/thresholds/conversations/:conversationId', (c) =>
  withScope(c, 'permissions', async ({ scope }) => {
    const data = await getAssistantCompatRepo().getSetting(scope, 'conversation-thresholds')
    const threshold = data[c.req.param('conversationId')]
    if (typeof threshold !== 'string') return c.json({ threshold: null }, 404)
    return c.json({ threshold }, 200)
  }),
)
assistantCompatRoute.put(
  '/:assistantId/permissions/thresholds/conversations/:conversationId',
  zValidator('json', conversationThresholdSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'permissions', async ({ scope }) => {
      const data = await getAssistantCompatRepo().getSetting(scope, 'conversation-thresholds')
      const next = { ...data, [c.req.param('conversationId')]: c.req.valid('json').threshold }
      await getAssistantCompatRepo().setSetting(scope, 'conversation-thresholds', next)
      return c.json({ threshold: c.req.valid('json').threshold }, 200)
    }),
)
assistantCompatRoute.delete('/:assistantId/permissions/thresholds/conversations/:conversationId', (c) =>
  withScope(c, 'permissions', async ({ scope }) => {
    const data = await getAssistantCompatRepo().getSetting(scope, 'conversation-thresholds')
    const next = { ...data }
    delete next[c.req.param('conversationId')]
    await getAssistantCompatRepo().setSetting(scope, 'conversation-thresholds', next)
    return c.json({ ok: true }, 200)
  }),
)

assistantCompatRoute.get('/:assistantId/workspace/tree', (c) =>
  withScope(c, 'workspace', async ({ scope }) => {
    try {
      return c.json(
        await workspaceTree({
          workspaceId: scope.workspaceId,
          assistantId: scope.assistantId,
          relPath: c.req.query('path'),
          showHidden: c.req.query('showHidden') === 'true',
        }),
        200,
      )
    } catch (err) {
      return workspaceError(c, err)
    }
  }),
)
assistantCompatRoute.get('/:assistantId/workspace/file', (c) =>
  withScope(c, 'workspace', async ({ scope }) => {
    try {
      return c.json(
        await workspaceEntry({
          workspaceId: scope.workspaceId,
          assistantId: scope.assistantId,
          relPath: c.req.query('path'),
          showHidden: c.req.query('showHidden') === 'true',
        }),
        200,
      )
    } catch (err) {
      return workspaceError(c, err)
    }
  }),
)
assistantCompatRoute.get('/:assistantId/workspace/file/content', (c) =>
  withScope(c, 'workspace', async ({ scope }) => {
    try {
      const resolved = resolveAssistantWorkspacePath({
        workspaceId: scope.workspaceId,
        assistantId: scope.assistantId,
        relPath: c.req.query('path'),
        showHidden: c.req.query('showHidden') === 'true',
      })
      const data = await fs.readFile(resolved.abs)
      return c.body(data)
    } catch (err) {
      return workspaceError(c, err)
    }
  }),
)
assistantCompatRoute.post(
  '/:assistantId/workspace/write',
  zValidator('json', writeFileSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'workspace', async ({ scope }) => {
      try {
        const body = c.req.valid('json')
        const resolved = resolveAssistantWorkspacePath({
          workspaceId: scope.workspaceId,
          assistantId: scope.assistantId,
          relPath: body.path,
          showHidden: true,
        })
        await fs.mkdir(path.dirname(resolved.abs), { recursive: true })
        const data = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : body.content
        await fs.writeFile(resolved.abs, data)
        return c.json({ ok: true, success: true }, 200)
      } catch (err) {
        return workspaceError(c, err)
      }
    }),
)
assistantCompatRoute.post(
  '/:assistantId/workspace/mkdir',
  zValidator('json', pathSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'workspace', async ({ scope }) => {
      try {
        const resolved = resolveAssistantWorkspacePath({
          workspaceId: scope.workspaceId,
          assistantId: scope.assistantId,
          relPath: c.req.valid('json').path,
          showHidden: true,
        })
        await fs.mkdir(resolved.abs, { recursive: true })
        return c.json({ ok: true, success: true }, 200)
      } catch (err) {
        return workspaceError(c, err)
      }
    }),
)
assistantCompatRoute.post(
  '/:assistantId/workspace/rename',
  zValidator('json', renameSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'workspace', async ({ scope }) => {
      try {
        const body = c.req.valid('json')
        const oldPath = resolveAssistantWorkspacePath({ workspaceId: scope.workspaceId, assistantId: scope.assistantId, relPath: body.oldPath, showHidden: true })
        const newPath = resolveAssistantWorkspacePath({ workspaceId: scope.workspaceId, assistantId: scope.assistantId, relPath: body.newPath, showHidden: true })
        await fs.mkdir(path.dirname(newPath.abs), { recursive: true })
        await fs.rename(oldPath.abs, newPath.abs)
        return c.json({ ok: true, success: true }, 200)
      } catch (err) {
        return workspaceError(c, err)
      }
    }),
)
assistantCompatRoute.post(
  '/:assistantId/workspace/delete',
  zValidator('json', pathSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'workspace', async ({ scope }) => {
      try {
        const resolved = resolveAssistantWorkspacePath({ workspaceId: scope.workspaceId, assistantId: scope.assistantId, relPath: c.req.valid('json').path, showHidden: true })
        await fs.rm(resolved.abs, { recursive: true, force: true })
        return c.json({ ok: true, success: true }, 200)
      } catch (err) {
        return workspaceError(c, err)
      }
    }),
)
assistantCompatRoute.get('/:assistantId/workspace-files', (c) =>
  withScope(c, 'workspace', async ({ scope }) =>
    c.json({ files: await listWorkspaceFiles({ workspaceId: scope.workspaceId, assistantId: scope.assistantId }) }, 200),
  ),
)

assistantCompatRoute.get('/:assistantId/conversation-starters', (c) =>
  withScope(c, 'conversation-starters', async () =>
    c.json({ starters: [], total: 0, status: 'empty' }, 200),
  ),
)
assistantCompatRoute.delete('/:assistantId/conversation-starters/:id', (c) =>
  withScope(c, 'conversation-starters', async () => c.json({ ok: true }, 200)),
)

assistantCompatRoute.get('/:assistantId/avatar/character-components', (c) =>
  withScope(c, 'avatar', async () => c.json({ components: {}, palettes: {} }, 200)),
)

assistantCompatRoute.get('/:assistantId/documents', (c) =>
  withScope(c, 'documents', async ({ scope }) => {
    const documents = await getAssistantCompatRepo().listDocuments(scope, c.req.query('conversationId'))
    return c.json({ documents: documents.map(serializeDocList) }, 200)
  }),
)
assistantCompatRoute.post(
  '/:assistantId/documents',
  zValidator('json', documentSaveSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'documents', async ({ scope }) => {
      const doc = await getAssistantCompatRepo().upsertDocument(scope, c.req.valid('json'))
      return c.json({ success: true, surfaceId: doc.surfaceId, error: null }, 200)
    }),
)
assistantCompatRoute.get('/:assistantId/documents/:surfaceId', (c) =>
  withScope(c, 'documents', async ({ scope }) => {
    const doc = await getAssistantCompatRepo().getDocument(scope, c.req.param('surfaceId'))
    if (!doc) return c.json({ detail: 'Document not found' }, 404)
    return c.json({ ...serializeDoc(doc), success: true, error: null }, 200)
  }),
)
assistantCompatRoute.get('/:assistantId/documents/:surfaceId/pdf', (c) =>
  withScope(c, 'documents', async ({ scope }) => {
    const doc = await getAssistantCompatRepo().getDocument(scope, c.req.param('surfaceId'))
    if (!doc) return c.json({ detail: 'Document not found' }, 404)
    return c.body(Buffer.from(doc.content), 200, { 'content-type': 'text/plain; charset=utf-8' })
  }),
)

assistantCompatRoute.get('/:assistantId/apps', (c) =>
  withScope(c, 'apps', async ({ scope }) => {
    const apps = await getAssistantCompatRepo().listApps(scope, c.req.query('conversationId'))
    return c.json({ apps: apps.map(serializeApp) }, 200)
  }),
)
assistantCompatRoute.post(
  '/:assistantId/apps',
  zValidator('json', appCreateSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'apps', async ({ scope }) => {
      const body = c.req.valid('json')
      const appId = body.appId ?? body.id ?? randomUUID()
      const app = await getAssistantCompatRepo().upsertApp(scope, { ...body, appId })
      return c.json({ app: serializeApp(app), success: true }, 201)
    }),
)
assistantCompatRoute.post('/:assistantId/apps/:appId/open', (c) =>
  withScope(c, 'apps', async ({ scope }) => {
    const app = await getAssistantCompatRepo().getApp(scope, c.req.param('appId'))
    if (!app) return c.json({ detail: 'App not found' }, 404)
    return c.json({ appId: app.appId, dirName: app.appId, name: app.name, html: app.html }, 200)
  }),
)
assistantCompatRoute.post('/:assistantId/apps/:appId/delete', (c) =>
  withScope(c, 'apps', async ({ scope }) => {
    const deleted = await getAssistantCompatRepo().deleteApp(scope, c.req.param('appId'))
    return c.json({ success: deleted, appId: c.req.param('appId'), error: deleted ? null : 'not_found' }, deleted ? 200 : 404)
  }),
)
assistantCompatRoute.get('/:assistantId/apps/:appId/preview', (c) =>
  withScope(c, 'apps', async ({ scope }) => {
    const app = await getAssistantCompatRepo().getApp(scope, c.req.param('appId'))
    if (!app) return c.json({ detail: 'App not found' }, 404)
    return c.json({ success: true, appId: app.appId, preview: app.preview ?? '' }, 200)
  }),
)
assistantCompatRoute.put(
  '/:assistantId/apps/:appId/preview',
  zValidator('json', previewSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'apps', async ({ scope }) => {
      const app = await getAssistantCompatRepo().updateAppPreview(
        scope,
        c.req.param('appId'),
        c.req.valid('json').preview,
      )
      if (!app) return c.json({ detail: 'App not found' }, 404)
      return c.json({ success: true, appId: app.appId, preview: app.preview }, 200)
    }),
)
assistantCompatRoute.get('/:assistantId/apps/shared', (c) =>
  withScope(c, 'apps', async () => c.json({ apps: [] }, 200)),
)
assistantCompatRoute.all('/:assistantId/apps/:appId/data', (c) =>
  withScope(c, 'apps', async ({ scope }) => {
    const app = await getAssistantCompatRepo().getApp(scope, c.req.param('appId'))
    if (!app) return c.json({ success: false, result: null, error: 'not_found' }, 404)
    return c.json({ success: true, result: null, error: null }, 200)
  }),
)
assistantCompatRoute.post('/:assistantId/apps/:appId/bundle', (c) =>
  withScope(c, 'apps', async () => c.json({ success: false, error: 'not_supported' }, 200)),
)
assistantCompatRoute.post('/:assistantId/apps/:appId/share-cloud', (c) =>
  withScope(c, 'apps', async () => c.json({ success: false, error: 'not_supported' }, 200)),
)

assistantCompatRoute.get('/:assistantId/routines', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const routines = await getAssistantCompatRepo().listRoutines(scope)
    return c.json({ routines: routines.map(serializeRoutine) }, 200)
  }),
)
assistantCompatRoute.post(
  '/:assistantId/routines',
  zValidator('json', routineCreateSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'routines', async ({ scope }) => {
      const routine = await getAssistantCompatRepo().createRoutine(scope, c.req.valid('json'))
      return c.json({ routine: serializeRoutine(routine) }, 201)
    }),
)
assistantCompatRoute.get('/:assistantId/routines/activity', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const activity = await getAssistantCompatRepo().listActivity(scope)
    return c.json(
      {
        activity: activity.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          title: row.title,
          summary: row.summary,
          occurredAt: timestampMs(row.occurredAt) ?? Date.now(),
          routineId: row.routineId,
          conversationId: row.conversationId,
          metadata: row.metadata,
        })),
      },
      200,
    )
  }),
)
assistantCompatRoute.get('/:assistantId/activity', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const activity = await getAssistantCompatRepo().listActivity(scope)
    return c.json({ activity }, 200)
  }),
)
assistantCompatRoute.get('/:assistantId/routines/:routineId', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const routine = await getAssistantCompatRepo().getRoutine(scope, c.req.param('routineId'))
    if (!routine) return c.json({ detail: 'Routine not found' }, 404)
    return c.json({ routine: serializeRoutine(routine) }, 200)
  }),
)
assistantCompatRoute.patch(
  '/:assistantId/routines/:routineId',
  zValidator('json', routinePatchSchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  (c) =>
    withScope(c, 'routines', async ({ scope }) => {
      const routine = await getAssistantCompatRepo().updateRoutine(
        scope,
        c.req.param('routineId'),
        c.req.valid('json'),
      )
      if (!routine) return c.json({ detail: 'Routine not found' }, 404)
      return c.json({ routine: serializeRoutine(routine) }, 200)
    }),
)
assistantCompatRoute.get('/:assistantId/routines/:routineId/artifacts', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const artifacts = await getAssistantCompatRepo().listArtifacts(scope, c.req.param('routineId'))
    return c.json(
      {
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          routineId: artifact.routineId,
          kind: artifact.kind,
          localUri: artifact.localUri,
          cloudUri: artifact.cloudUri,
          contentType: artifact.contentType,
          sizeBytes: artifact.sizeBytes,
          metadata: artifact.metadata,
          createdAt: timestampMs(artifact.createdAt) ?? Date.now(),
          expiresAt: timestampMs(artifact.expiresAt),
        })),
      },
      200,
    )
  }),
)
assistantCompatRoute.get('/:assistantId/routines/:routineId/review-context', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const routine = await getAssistantCompatRepo().getRoutine(scope, c.req.param('routineId'))
    if (!routine) return c.json({ detail: 'Routine not found' }, 404)
    return c.json(
      {
        reviewContext: {
          routineId: routine.id,
          title: routine.title,
          status: routine.status,
          capture: {
            capturedAt: timestampMs(routine.createdAt) ?? Date.now(),
            startedAt: timestampMs(routine.startedAt),
            stoppedAt: timestampMs(routine.stoppedAt),
            durationMs: null,
            sourceType: routine.sourceKind,
          },
          counts: { frames: 0, snapshots: 0, events: 0, ocrCharacters: 0 },
          surfaces: { appNames: [], windowNames: [] },
          artifacts: { captureSessionAvailable: false, availableKinds: [], count: 0 },
          warnings: [],
        },
      },
      200,
    )
  }),
)
assistantCompatRoute.post('/:assistantId/routines/:routineId/assistant-review', (c) =>
  withScope(c, 'routines', async ({ scope }) => {
    const routine = await getAssistantCompatRepo().getRoutine(scope, c.req.param('routineId'))
    if (!routine) return c.json({ detail: 'Routine not found' }, 404)
    return c.json({ routine: serializeRoutine(routine), conversationId: routine.id, messageId: null }, 200)
  }),
)
assistantCompatRoute.post('/:assistantId/routines/:routineId/run-background', (c) =>
  withScope(c, 'routines', async () => c.json(disabledAction(c.req.param('routineId'), 'cloud_execution'), 200)),
)
assistantCompatRoute.post('/:assistantId/routines/:routineId/schedule', (c) =>
  withScope(c, 'routines', async () => c.json(disabledAction(c.req.param('routineId'), 'scheduling'), 200)),
)

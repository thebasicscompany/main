import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/index.js'
import { clientAssistantProfiles } from '../db/schema.js'
import { workspaces } from '../db/workspaces.js'
import { DatabaseUnavailableError } from '../lib/errors.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import { rotateAssistantApiKey } from '../lib/workspace-api-keys.js'
import { logger } from '../middleware/logger.js'
import {
  getDesktopAssistantsRepo,
  type DesktopAssistantRecord,
} from '../orchestrator/desktopAssistantsRepo.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const platformRoute = new Hono<{ Variables: Vars }>()

const localRegistrationBodySchema = z
  .object({
    client_installation_id: z.string().min(1).max(256),
    runtime_assistant_id: z.string().min(1).max(256),
    client_platform: z.string().min(1).max(64),
    assistant_version: z.string().min(1).max(128).nullable().optional(),
    machine_name: z.string().min(1).max(256).nullable().optional(),
  })
  .strict()

const hatchBodySchema = z
  .object({
    name: z.string().min(1).max(256).nullable().optional(),
    description: z.string().max(4096).nullable().optional(),
    anthropic_api_key: z.string().nullable().optional(),
  })
  .strict()

const patchAssistantBodySchema = z
  .object({
    name: z.string().min(1).max(256).nullable().optional(),
    description: z.string().max(4096).nullable().optional(),
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

function assistantToPlatform(record: DesktopAssistantRecord) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    hosting: record.hosting,
    status: record.status,
    runtime_assistant_id: record.runtimeAssistantId,
    client_installation_id: record.clientInstallationId,
    client_platform: record.clientPlatform,
    assistant_version: record.assistantVersion,
    machine_name: record.machineName,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    last_seen_at: record.lastSeenAt,
    recovery_mode: null,
  }
}

function stringFromProfile(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

async function activeProfileData(record: DesktopAssistantRecord) {
  try {
    const rows = await getDb()
      .select({ data: clientAssistantProfiles.data })
      .from(clientAssistantProfiles)
      .where(
        and(
          eq(clientAssistantProfiles.workspaceId, record.workspaceId),
          eq(clientAssistantProfiles.assistantId, record.id),
          eq(clientAssistantProfiles.active, true),
        ),
      )
      .limit(1)
    return rows[0]?.data ?? {}
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) return {}
    throw err
  }
}

async function assistantToIdentity(record: DesktopAssistantRecord) {
  const profile = await activeProfileData(record)
  const name =
    stringFromProfile(profile, ['displayName', 'assistantName', 'name']) ??
    record.name ??
    'Basics Assistant'
  const role =
    stringFromProfile(profile, ['role', 'title']) ?? record.description ?? ''
  return {
    name,
    role,
    personality: stringFromProfile(profile, ['personality', 'style', 'tone']) ?? '',
    emoji: stringFromProfile(profile, ['emoji', 'icon']) ?? '',
    home: stringFromProfile(profile, ['home']) ?? '',
    version: record.assistantVersion ?? 'cloud',
    createdAt:
      stringFromProfile(profile, ['createdAt', 'created_at']) ?? record.createdAt,
  }
}

function registrationResponse(input: {
  assistant: DesktopAssistantRecord
  assistantApiKey: string | null
  assistantApiKeyId?: string | null
  webhookSecret: string | null
  rotated?: boolean
}) {
  return {
    assistant: assistantToPlatform(input.assistant),
    registration: {
      client_installation_id: input.assistant.clientInstallationId,
      runtime_assistant_id: input.assistant.runtimeAssistantId,
      client_platform: input.assistant.clientPlatform,
    },
    assistant_api_key: input.assistantApiKey,
    assistant_api_key_id: input.assistantApiKeyId ?? null,
    webhook_secret: input.webhookSecret,
    credential_name: 'basics:assistant_api_key',
    rotated: input.rotated ?? false,
  }
}

async function rotateCredentialForAssistant(input: {
  workspace: WorkspaceToken
  assistant: DesktopAssistantRecord
}) {
  try {
    return await rotateAssistantApiKey({
      workspaceId: input.workspace.workspace_id,
      accountId: input.workspace.account_id,
      clientInstallationId: input.assistant.clientInstallationId,
      assistantId: input.assistant.id,
      assistantVersion: input.assistant.assistantVersion,
      platform: input.assistant.clientPlatform,
      machineName: input.assistant.machineName,
    })
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return null
    }
    throw err
  }
}

async function workspaceName(workspaceId: string) {
  try {
    const rows = await getDb()
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    return rows[0]?.name ?? 'Basics Workspace'
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) return 'Basics Workspace'
    logger.warn({ err, workspaceId }, 'workspace name lookup failed')
    return 'Basics Workspace'
  }
}

platformRoute.get('/organizations/', async (c) => {
  const workspace = c.get('workspace')
  return c.json(
    {
      count: 1,
      next: null,
      previous: null,
      results: [
        {
          id: workspace.workspace_id,
          name: await workspaceName(workspace.workspace_id),
        },
      ],
    },
    200,
  )
})

platformRoute.get('/assistants/', async (c) => {
  const workspace = c.get('workspace')
  const hostingParam = c.req.query('hosting')
  // Default to the cloud product surface. Self-hosted local registrations are
  // still available through ?hosting=local, but managed bootstrap treats the
  // unfiltered list as "cloud assistants I can connect to through Runtime".
  const hosting = hostingParam === 'local' || hostingParam === 'managed'
    ? hostingParam
    : 'managed'
  const rows = await getDesktopAssistantsRepo().list({
    workspaceId: workspace.workspace_id,
    hosting,
  })
  return c.json(
    {
      count: rows.length,
      next: null,
      previous: null,
      results: rows.map(assistantToPlatform),
    },
    200,
  )
})

platformRoute.get('/assistants/active/', async (c) => {
  const workspace = c.get('workspace')
  const assistant = await getDesktopAssistantsRepo().getActive(workspace.workspace_id)
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json(assistantToPlatform(assistant), 200)
})

platformRoute.post(
  '/assistants/hatch/',
  zValidator('json', hatchBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const body = c.req.valid('json')
    const mode = c.req.query('mode') === 'create' ? 'create' : 'ensure'
    const result = await getDesktopAssistantsRepo().hatch({
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      name: body.name ?? null,
      description: body.description ?? null,
      mode,
    })
    return c.json(assistantToPlatform(result.assistant), result.created ? 201 : 200)
  },
)

platformRoute.get('/assistants/:assistantId/', async (c) => {
  const workspace = c.get('workspace')
  const assistant = await getDesktopAssistantsRepo().get(
    workspace.workspace_id,
    c.req.param('assistantId'),
  )
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json(assistantToPlatform(assistant), 200)
})

async function handleAssistantIdentity(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistant = await getDesktopAssistantsRepo().get(
    workspace.workspace_id,
    c.req.param('assistantId'),
  )
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json(await assistantToIdentity(assistant), 200)
}

async function handleAssistantIdentityIntro(c: {
  get: (key: 'workspace') => WorkspaceToken
  req: { param: (key: 'assistantId') => string }
  json: (body: unknown, status?: number) => Response
}) {
  const workspace = c.get('workspace')
  const assistant = await getDesktopAssistantsRepo().get(
    workspace.workspace_id,
    c.req.param('assistantId'),
  )
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  const identity = await assistantToIdentity(assistant)
  return c.json({ text: `Hi, I'm ${identity.name}.` }, 200)
}

platformRoute.get('/assistants/:assistantId/identity/intro', handleAssistantIdentityIntro)
platformRoute.get('/assistants/:assistantId/identity/intro/', handleAssistantIdentityIntro)
platformRoute.get('/assistants/:assistantId/identity', handleAssistantIdentity)
platformRoute.get('/assistants/:assistantId/identity/', handleAssistantIdentity)

platformRoute.patch(
  '/assistants/:assistantId/',
  zValidator('json', patchAssistantBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const body = c.req.valid('json')
    const assistant = await getDesktopAssistantsRepo().update(
      workspace.workspace_id,
      c.req.param('assistantId'),
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
    )
    if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
    return c.json(assistantToPlatform(assistant), 200)
  },
)

platformRoute.post('/assistants/:assistantId/activate/', async (c) => {
  const workspace = c.get('workspace')
  const assistant = await getDesktopAssistantsRepo().activate(
    workspace.workspace_id,
    c.req.param('assistantId'),
  )
  if (!assistant) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json(assistantToPlatform(assistant), 200)
})

platformRoute.post(
  '/assistants/self-hosted-local/ensure-registration/',
  zValidator('json', localRegistrationBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const body = c.req.valid('json')
    const result = await getDesktopAssistantsRepo().ensureLocalRegistration({
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      clientInstallationId: body.client_installation_id,
      runtimeAssistantId: body.runtime_assistant_id,
      clientPlatform: body.client_platform,
      assistantVersion: body.assistant_version ?? null,
      machineName: body.machine_name ?? null,
    })
    const credential = result.assistantApiKey
      ? await rotateCredentialForAssistant({ workspace, assistant: result.assistant })
      : null
    if (result.assistantApiKey && !credential) {
      return c.json({ error: 'not_configured' }, 503)
    }
    const response = registrationResponse({
      assistant: result.assistant,
      assistantApiKey: credential?.key ?? null,
      assistantApiKeyId: credential?.meta.id ?? null,
      webhookSecret: result.webhookSecret,
    })
    return c.json(response, credential ? 201 : 200)
  },
)

platformRoute.post(
  '/assistants/self-hosted-local/reprovision-api-key/',
  zValidator('json', localRegistrationBodySchema, (result, c) =>
    result.success ? undefined : invalidRequest(result, c),
  ),
  async (c) => {
    const workspace = c.get('workspace')
    const requestBody = c.req.valid('json')
    const result = await getDesktopAssistantsRepo().reprovisionLocalRegistration({
      workspaceId: workspace.workspace_id,
      accountId: workspace.account_id,
      clientInstallationId: requestBody.client_installation_id,
      runtimeAssistantId: requestBody.runtime_assistant_id,
      clientPlatform: requestBody.client_platform,
      assistantVersion: requestBody.assistant_version ?? null,
      machineName: requestBody.machine_name ?? null,
    })
    const credential = await rotateCredentialForAssistant({
      workspace,
      assistant: result.assistant,
    })
    if (!credential) return c.json({ error: 'not_configured' }, 503)
    const responseBody = registrationResponse({
      assistant: result.assistant,
      assistantApiKey: credential.key,
      assistantApiKeyId: credential.meta.id,
      webhookSecret: result.webhookSecret,
      rotated: true,
    })
    return c.json(
      {
        assistant: responseBody.assistant,
        provisioning: {
          credential_name: responseBody.credential_name,
          assistant_api_key: responseBody.assistant_api_key,
          assistant_api_key_id: responseBody.assistant_api_key_id,
          rotated: true,
        },
      },
      200,
    )
  },
)

platformRoute.delete('/assistants/:assistantId/retire/', async (c) => {
  const workspace = c.get('workspace')
  const result = await getDesktopAssistantsRepo().retire(
    workspace.workspace_id,
    c.req.param('assistantId'),
  )
  if (!result.retired) return c.json({ detail: 'Assistant not found' }, 404)
  return c.json({ detail: 'Assistant retired' }, 200)
})

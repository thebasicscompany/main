import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import {
  clientApps,
  clientDocuments,
  clientRoutineArtifacts,
  clientRoutineRuns,
  clientRoutines,
  clientSettings,
  type ClientApp,
  type ClientDocument,
  type ClientRoutine,
  type ClientRoutineArtifact,
  type ClientRoutineRun,
} from '../db/schema.js'
import { DatabaseUnavailableError } from '../lib/errors.js'

export type CompatScope = {
  workspaceId: string
  accountId: string
  assistantId: string
}

export type CompatDocument = {
  surfaceId: string
  conversationId: string
  title: string
  content: string
  wordCount: number
  createdAt: string
  updatedAt: string
}

export type CompatApp = {
  appId: string
  conversationId: string | null
  name: string
  description: string | null
  icon: string | null
  preview: string | null
  html: string
  version: string | null
  contentId: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CompatRoutine = {
  id: string
  title: string
  status: string
  sourceKind: string
  lensSessionId: string | null
  extensionRecordingId: string | null
  startedAt: string | null
  stoppedAt: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CompatRoutineArtifact = {
  id: string
  routineId: string
  kind: string
  localUri: string | null
  cloudUri: string | null
  contentType: string | null
  sizeBytes: number | null
  metadata: Record<string, unknown>
  createdAt: string
  expiresAt: string | null
}

export type CompatActivity = {
  id: string
  kind: string
  status: string
  title: string
  summary: string
  occurredAt: string
  routineId: string | null
  conversationId: string | null
  metadata: Record<string, unknown>
}

function iso(date: Date | null | undefined) {
  return (date ?? new Date()).toISOString()
}

function docFromRow(row: ClientDocument): CompatDocument {
  return {
    surfaceId: row.surfaceId,
    conversationId: row.conversationId,
    title: row.title,
    content: row.content,
    wordCount: row.wordCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

function appFromRow(row: ClientApp): CompatApp {
  return {
    appId: row.appId,
    conversationId: row.conversationId ?? null,
    name: row.name,
    description: row.description ?? null,
    icon: row.icon ?? null,
    preview: row.preview ?? null,
    html: row.html,
    version: row.version ?? null,
    contentId: row.contentId ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

function routineFromRow(row: ClientRoutine): CompatRoutine {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    sourceKind: row.sourceKind,
    lensSessionId: row.lensSessionId ?? null,
    extensionRecordingId: row.extensionRecordingId ?? null,
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    stoppedAt: row.stoppedAt ? iso(row.stoppedAt) : null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

function artifactFromRow(row: ClientRoutineArtifact): CompatRoutineArtifact {
  return {
    id: row.id,
    routineId: row.routineId,
    kind: row.kind,
    localUri: row.localUri ?? null,
    cloudUri: row.cloudUri ?? null,
    contentType: row.contentType ?? null,
    sizeBytes: row.sizeBytes ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.createdAt),
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
  }
}

function activityFromRow(row: ClientRoutineRun): CompatActivity {
  return {
    id: row.id,
    kind: String(row.metadata?.kind ?? 'run'),
    status: row.status,
    title: row.title,
    summary: row.summary,
    occurredAt: iso(row.createdAt),
    routineId: row.routineId ?? null,
    conversationId:
      typeof row.metadata?.conversationId === 'string'
        ? row.metadata.conversationId
        : null,
    metadata: row.metadata ?? {},
  }
}

function memoryKey(scope: CompatScope, id: string) {
  return `${scope.workspaceId}:${scope.accountId}:${scope.assistantId}:${id}`
}

const memorySettings = new Map<string, Record<string, unknown>>()
const memoryDocuments = new Map<string, CompatDocument>()
const memoryApps = new Map<string, CompatApp>()
const memoryRoutines = new Map<string, CompatRoutine>()
const memoryArtifacts = new Map<string, CompatRoutineArtifact>()
const memoryActivity = new Map<string, CompatActivity>()

function useMemoryFallback(err: unknown) {
  if (err instanceof DatabaseUnavailableError) return true
  if (process.env.NODE_ENV === 'test') return true
  return false
}

export class AssistantCompatRepo {
  async getSetting(scope: CompatScope, settingScope: string) {
    try {
      const rows = await getDb()
        .select({ data: clientSettings.data })
        .from(clientSettings)
        .where(
          and(
            eq(clientSettings.workspaceId, scope.workspaceId),
            eq(clientSettings.accountId, scope.accountId),
            eq(clientSettings.assistantId, scope.assistantId),
            eq(clientSettings.scope, settingScope),
          ),
        )
        .limit(1)
      return rows[0]?.data ?? {}
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return memorySettings.get(memoryKey(scope, settingScope)) ?? {}
    }
  }

  async setSetting(scope: CompatScope, settingScope: string, data: Record<string, unknown>) {
    try {
      const rows = await getDb()
        .insert(clientSettings)
        .values({
          workspaceId: scope.workspaceId,
          accountId: scope.accountId,
          assistantId: scope.assistantId,
          scope: settingScope,
          data,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            clientSettings.workspaceId,
            clientSettings.accountId,
            clientSettings.assistantId,
            clientSettings.scope,
          ],
          set: { data, updatedAt: sql`now()` },
        })
        .returning({ data: clientSettings.data })
      return rows[0]?.data ?? data
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      memorySettings.set(memoryKey(scope, settingScope), data)
      return data
    }
  }

  async listDocuments(scope: CompatScope, conversationId?: string | null) {
    try {
      const where = [
        eq(clientDocuments.workspaceId, scope.workspaceId),
        eq(clientDocuments.assistantId, scope.assistantId),
      ]
      if (conversationId) where.push(eq(clientDocuments.conversationId, conversationId))
      const rows = await getDb()
        .select()
        .from(clientDocuments)
        .where(and(...where))
        .orderBy(desc(clientDocuments.updatedAt))
      return rows.map(docFromRow)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      const prefix = `${scope.workspaceId}:${scope.accountId}:${scope.assistantId}:doc:`
      return [...memoryDocuments.entries()]
        .filter(([key, d]) => key.startsWith(prefix) && (!conversationId || d.conversationId === conversationId))
        .map(([, d]) => d)
    }
  }

  async getDocument(scope: CompatScope, surfaceId: string) {
    try {
      const rows = await getDb()
        .select()
        .from(clientDocuments)
        .where(
          and(
            eq(clientDocuments.workspaceId, scope.workspaceId),
            eq(clientDocuments.assistantId, scope.assistantId),
            eq(clientDocuments.surfaceId, surfaceId),
          ),
        )
        .limit(1)
      return rows[0] ? docFromRow(rows[0]) : null
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return memoryDocuments.get(memoryKey(scope, `doc:${surfaceId}`)) ?? null
    }
  }

  async upsertDocument(
    scope: CompatScope,
    input: {
      surfaceId: string
      conversationId: string
      title: string
      content: string
      wordCount: number
    },
  ) {
    const now = new Date()
    try {
      const rows = await getDb()
        .insert(clientDocuments)
        .values({
          workspaceId: scope.workspaceId,
          accountId: scope.accountId,
          assistantId: scope.assistantId,
          surfaceId: input.surfaceId,
          conversationId: input.conversationId,
          title: input.title,
          content: input.content,
          wordCount: input.wordCount,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            clientDocuments.workspaceId,
            clientDocuments.assistantId,
            clientDocuments.surfaceId,
          ],
          set: {
            conversationId: input.conversationId,
            title: input.title,
            content: input.content,
            wordCount: input.wordCount,
            updatedAt: sql`now()`,
          },
        })
        .returning()
      return docFromRow(rows[0]!)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      const existing = memoryDocuments.get(memoryKey(scope, `doc:${input.surfaceId}`))
      const doc = {
        ...input,
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      }
      memoryDocuments.set(memoryKey(scope, `doc:${input.surfaceId}`), doc)
      return doc
    }
  }

  async listApps(scope: CompatScope, conversationId?: string | null) {
    try {
      const where = [
        eq(clientApps.workspaceId, scope.workspaceId),
        eq(clientApps.assistantId, scope.assistantId),
      ]
      if (conversationId) where.push(eq(clientApps.conversationId, conversationId))
      const rows = await getDb()
        .select()
        .from(clientApps)
        .where(and(...where))
        .orderBy(desc(clientApps.updatedAt))
      return rows.map(appFromRow)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return [...memoryApps.values()].filter(
        (app) =>
          memoryApps.get(memoryKey(scope, `app:${app.appId}`)) === app &&
          (!conversationId || app.conversationId === conversationId),
      )
    }
  }

  async getApp(scope: CompatScope, appId: string) {
    try {
      const rows = await getDb()
        .select()
        .from(clientApps)
        .where(
          and(
            eq(clientApps.workspaceId, scope.workspaceId),
            eq(clientApps.assistantId, scope.assistantId),
            eq(clientApps.appId, appId),
          ),
        )
        .limit(1)
      return rows[0] ? appFromRow(rows[0]) : null
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return memoryApps.get(memoryKey(scope, `app:${appId}`)) ?? null
    }
  }

  async updateAppPreview(scope: CompatScope, appId: string, preview: string) {
    try {
      const rows = await getDb()
        .update(clientApps)
        .set({ preview, updatedAt: new Date() })
        .where(
          and(
            eq(clientApps.workspaceId, scope.workspaceId),
            eq(clientApps.assistantId, scope.assistantId),
            eq(clientApps.appId, appId),
          ),
        )
        .returning()
      return rows[0] ? appFromRow(rows[0]) : null
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      const app = memoryApps.get(memoryKey(scope, `app:${appId}`))
      if (!app) return null
      const next = { ...app, preview, updatedAt: new Date().toISOString() }
      memoryApps.set(memoryKey(scope, `app:${appId}`), next)
      return next
    }
  }

  async deleteApp(scope: CompatScope, appId: string) {
    try {
      const rows = await getDb()
        .delete(clientApps)
        .where(
          and(
            eq(clientApps.workspaceId, scope.workspaceId),
            eq(clientApps.assistantId, scope.assistantId),
            eq(clientApps.appId, appId),
          ),
        )
        .returning({ id: clientApps.id })
      return rows.length > 0
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return memoryApps.delete(memoryKey(scope, `app:${appId}`))
    }
  }

  async upsertApp(
    scope: CompatScope,
    input: {
      appId: string
      conversationId?: string | null
      name: string
      description?: string | null
      icon?: string | null
      preview?: string | null
      html?: string | null
      version?: string | null
      contentId?: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    const now = new Date()
    try {
      const rows = await getDb()
        .insert(clientApps)
        .values({
          workspaceId: scope.workspaceId,
          accountId: scope.accountId,
          assistantId: scope.assistantId,
          appId: input.appId,
          conversationId: input.conversationId ?? null,
          name: input.name,
          description: input.description ?? null,
          icon: input.icon ?? null,
          preview: input.preview ?? null,
          html: input.html ?? '',
          version: input.version ?? null,
          contentId: input.contentId ?? null,
          metadata: input.metadata ?? {},
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [clientApps.workspaceId, clientApps.assistantId, clientApps.appId],
          set: {
            conversationId: input.conversationId ?? null,
            name: input.name,
            description: input.description ?? null,
            icon: input.icon ?? null,
            preview: input.preview ?? null,
            html: input.html ?? '',
            version: input.version ?? null,
            contentId: input.contentId ?? null,
            metadata: input.metadata ?? {},
            updatedAt: sql`now()`,
          },
        })
        .returning()
      return appFromRow(rows[0]!)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      const existing = memoryApps.get(memoryKey(scope, `app:${input.appId}`))
      const app: CompatApp = {
        appId: input.appId,
        conversationId: input.conversationId ?? null,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        preview: input.preview ?? null,
        html: input.html ?? '',
        version: input.version ?? null,
        contentId: input.contentId ?? null,
        metadata: input.metadata ?? {},
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      }
      memoryApps.set(memoryKey(scope, `app:${input.appId}`), app)
      return app
    }
  }

  async createRoutine(
    scope: CompatScope,
    input: {
      title?: string
      status?: string
      sourceKind?: string
      metadata?: Record<string, unknown>
    },
  ) {
    try {
      const rows = await getDb()
        .insert(clientRoutines)
        .values({
          workspaceId: scope.workspaceId,
          accountId: scope.accountId,
          assistantId: scope.assistantId,
          title: input.title ?? 'Untitled routine',
          status: input.status ?? 'draft',
          sourceKind: input.sourceKind ?? 'manual',
          metadata: input.metadata ?? {},
        })
        .returning()
      return routineFromRow(rows[0]!)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      const now = new Date().toISOString()
      const routine: CompatRoutine = {
        id: randomUUID(),
        title: input.title ?? 'Untitled routine',
        status: input.status ?? 'draft',
        sourceKind: input.sourceKind ?? 'manual',
        lensSessionId: null,
        extensionRecordingId: null,
        startedAt: null,
        stoppedAt: null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      }
      memoryRoutines.set(memoryKey(scope, `routine:${routine.id}`), routine)
      return routine
    }
  }

  async listRoutines(scope: CompatScope) {
    try {
      const rows = await getDb()
        .select()
        .from(clientRoutines)
        .where(
          and(
            eq(clientRoutines.workspaceId, scope.workspaceId),
            eq(clientRoutines.assistantId, scope.assistantId),
          ),
        )
        .orderBy(desc(clientRoutines.updatedAt))
      return rows.map(routineFromRow)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return [...memoryRoutines.values()].filter(
        (routine) =>
          memoryRoutines.get(memoryKey(scope, `routine:${routine.id}`)) === routine,
      )
    }
  }

  async getRoutine(scope: CompatScope, routineId: string) {
    try {
      const rows = await getDb()
        .select()
        .from(clientRoutines)
        .where(
          and(
            eq(clientRoutines.workspaceId, scope.workspaceId),
            eq(clientRoutines.assistantId, scope.assistantId),
            eq(clientRoutines.id, routineId),
          ),
        )
        .limit(1)
      return rows[0] ? routineFromRow(rows[0]) : null
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return memoryRoutines.get(memoryKey(scope, `routine:${routineId}`)) ?? null
    }
  }

  async updateRoutine(
    scope: CompatScope,
    routineId: string,
    patch: { title?: string; metadata?: Record<string, unknown> },
  ) {
    try {
      const rows = await getDb()
        .update(clientRoutines)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clientRoutines.workspaceId, scope.workspaceId),
            eq(clientRoutines.assistantId, scope.assistantId),
            eq(clientRoutines.id, routineId),
          ),
        )
        .returning()
      return rows[0] ? routineFromRow(rows[0]) : null
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      const routine = memoryRoutines.get(memoryKey(scope, `routine:${routineId}`))
      if (!routine) return null
      const next = { ...routine, ...patch, updatedAt: new Date().toISOString() }
      memoryRoutines.set(memoryKey(scope, `routine:${routineId}`), next)
      return next
    }
  }

  async listArtifacts(scope: CompatScope, routineId: string) {
    try {
      const rows = await getDb()
        .select()
        .from(clientRoutineArtifacts)
        .where(
          and(
            eq(clientRoutineArtifacts.workspaceId, scope.workspaceId),
            eq(clientRoutineArtifacts.assistantId, scope.assistantId),
            eq(clientRoutineArtifacts.routineId, routineId),
          ),
        )
        .orderBy(desc(clientRoutineArtifacts.createdAt))
      return rows.map(artifactFromRow)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return [...memoryArtifacts.values()].filter(
        (artifact) =>
          artifact.routineId === routineId &&
          memoryArtifacts.get(memoryKey(scope, `artifact:${artifact.id}`)) === artifact,
      )
    }
  }

  async listActivity(scope: CompatScope) {
    try {
      const rows = await getDb()
        .select()
        .from(clientRoutineRuns)
        .where(
          and(
            eq(clientRoutineRuns.workspaceId, scope.workspaceId),
            eq(clientRoutineRuns.assistantId, scope.assistantId),
          ),
        )
        .orderBy(desc(clientRoutineRuns.createdAt))
      return rows.map(activityFromRow)
    } catch (err) {
      if (!useMemoryFallback(err)) throw err
      return [...memoryActivity.values()].filter(
        (row) => memoryActivity.get(memoryKey(scope, `activity:${row.id}`)) === row,
      )
    }
  }

  __resetForTests() {
    memorySettings.clear()
    memoryDocuments.clear()
    memoryApps.clear()
    memoryRoutines.clear()
    memoryArtifacts.clear()
    memoryActivity.clear()
  }
}

let repo = new AssistantCompatRepo()

export function getAssistantCompatRepo() {
  return repo
}

export function __setAssistantCompatRepoForTests(next: AssistantCompatRepo) {
  repo = next
}

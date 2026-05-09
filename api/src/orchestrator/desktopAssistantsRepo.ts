import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import {
  clientAssistants as clientAssistantsTable,
  type ClientAssistant,
} from '../db/schema.js'

export type ClientAssistantHosting = 'local' | 'managed'
export type ClientAssistantStatus = 'active' | 'retired'

export interface ClientAssistantRecord {
  id: string
  workspaceId: string
  accountId: string
  clientInstallationId: string
  runtimeAssistantId: string
  clientPlatform: string
  assistantVersion: string | null
  machineName: string | null
  name: string | null
  description: string | null
  hosting: ClientAssistantHosting
  status: ClientAssistantStatus
  active: boolean
  createdAt: string
  updatedAt: string
  lastSeenAt: string
  retiredAt: string | null
}

export interface EnsureLocalRegistrationInput {
  workspaceId: string
  accountId: string
  clientInstallationId: string
  runtimeAssistantId: string
  clientPlatform: string
  assistantVersion?: string | null
  machineName?: string | null
}

export interface HatchAssistantInput {
  workspaceId: string
  accountId: string
  name?: string | null
  description?: string | null
  mode: 'ensure' | 'create'
}

export interface ClientAssistantsRepo {
  list(input: {
    workspaceId: string
    hosting?: ClientAssistantHosting
  }): Promise<ClientAssistantRecord[]>
  get(workspaceId: string, assistantId: string): Promise<ClientAssistantRecord | null>
  getActive(workspaceId: string): Promise<ClientAssistantRecord | null>
  activate(workspaceId: string, assistantId: string): Promise<ClientAssistantRecord | null>
  update(
    workspaceId: string,
    assistantId: string,
    patch: { name?: string | null; description?: string | null },
  ): Promise<ClientAssistantRecord | null>
  ensureLocalRegistration(input: EnsureLocalRegistrationInput): Promise<{
    assistant: ClientAssistantRecord
    assistantApiKey: string | null
    webhookSecret: string | null
  }>
  reprovisionLocalRegistration(input: EnsureLocalRegistrationInput): Promise<{
    assistant: ClientAssistantRecord
    assistantApiKey: string
    webhookSecret: string | null
  }>
  hatch(input: HatchAssistantInput): Promise<{
    assistant: ClientAssistantRecord
    created: boolean
  }>
  retire(workspaceId: string, assistantId: string): Promise<{ retired: boolean }>
}

function nowIso() {
  return new Date().toISOString()
}

function generateAssistantApiKey(): string {
  return `basics_asst_${randomBytes(32).toString('base64url')}`
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function defaultName(hosting: ClientAssistantHosting, machineName?: string | null) {
  if (hosting === 'managed') return 'Basics Assistant'
  return machineName ? `${machineName} Assistant` : 'Local Assistant'
}

function rowToRecord(row: ClientAssistant): ClientAssistantRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    clientInstallationId: row.clientInstallationId,
    runtimeAssistantId: row.runtimeAssistantId,
    clientPlatform: row.clientPlatform,
    assistantVersion: row.assistantVersion ?? null,
    machineName: row.machineName ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    hosting: row.hosting as ClientAssistantHosting,
    status: row.status as ClientAssistantStatus,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  }
}

let memoryCounter = 0

export function createMemoryClientAssistantsRepo(): ClientAssistantsRepo & {
  __reset: () => void
} {
  const store = new Map<string, ClientAssistantRecord & { apiKeyHash: string }>()

  function deactivateOthers(workspaceId: string, activeId: string) {
    for (const [id, rec] of store) {
      if (rec.workspaceId === workspaceId && id !== activeId) {
        store.set(id, { ...rec, active: false, updatedAt: nowIso() })
      }
    }
  }

  return {
    async list(input) {
      return [...store.values()]
        .filter((rec) => {
          if (rec.workspaceId !== input.workspaceId) return false
          if (rec.status !== 'active') return false
          if (input.hosting && rec.hosting !== input.hosting) return false
          return true
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    async get(workspaceId, assistantId) {
      const rec = store.get(assistantId)
      return rec?.workspaceId === workspaceId && rec.status === 'active'
        ? rec
        : null
    },
    async getActive(workspaceId) {
      return (
        [...store.values()].find(
          (rec) =>
            rec.workspaceId === workspaceId &&
            rec.status === 'active' &&
            rec.active,
        ) ?? null
      )
    },
    async activate(workspaceId, assistantId) {
      const rec = store.get(assistantId)
      if (!rec || rec.workspaceId !== workspaceId || rec.status !== 'active') {
        return null
      }
      deactivateOthers(workspaceId, assistantId)
      const next = { ...rec, active: true, updatedAt: nowIso() }
      store.set(assistantId, next)
      return next
    },
    async update(workspaceId, assistantId, patch) {
      const rec = store.get(assistantId)
      if (!rec || rec.workspaceId !== workspaceId || rec.status !== 'active') {
        return null
      }
      const next = {
        ...rec,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        updatedAt: nowIso(),
      }
      store.set(assistantId, next)
      return next
    },
    async ensureLocalRegistration(input) {
      const existing = [...store.values()].find(
        (rec) =>
          rec.workspaceId === input.workspaceId &&
          rec.clientInstallationId === input.clientInstallationId &&
          rec.runtimeAssistantId === input.runtimeAssistantId &&
          rec.status === 'active',
      )
      if (existing) {
        const next = {
          ...existing,
          accountId: input.accountId,
          clientPlatform: input.clientPlatform,
          assistantVersion: input.assistantVersion ?? null,
          machineName: input.machineName ?? null,
          lastSeenAt: nowIso(),
          updatedAt: nowIso(),
        }
        store.set(next.id, next)
        return { assistant: next, assistantApiKey: null, webhookSecret: null }
      }
      const apiKey = generateAssistantApiKey()
      memoryCounter++
      const id = `asst-${memoryCounter}-${randomUUID()}`
      const rec = {
        id,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientInstallationId: input.clientInstallationId,
        runtimeAssistantId: input.runtimeAssistantId,
        clientPlatform: input.clientPlatform,
        assistantVersion: input.assistantVersion ?? null,
        machineName: input.machineName ?? null,
        name: defaultName('local', input.machineName),
        description: null,
        hosting: 'local' as const,
        status: 'active' as const,
        active: true,
        apiKeyHash: hashSecret(apiKey),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastSeenAt: nowIso(),
        retiredAt: null,
      }
      deactivateOthers(input.workspaceId, id)
      store.set(id, rec)
      return { assistant: rec, assistantApiKey: apiKey, webhookSecret: null }
    },
    async reprovisionLocalRegistration(input) {
      const ensured = await this.ensureLocalRegistration(input)
      const apiKey = generateAssistantApiKey()
      const current = store.get(ensured.assistant.id)!
      const next = { ...current, apiKeyHash: hashSecret(apiKey), updatedAt: nowIso() }
      store.set(next.id, next)
      return { assistant: next, assistantApiKey: apiKey, webhookSecret: null }
    },
    async hatch(input) {
      if (input.mode === 'ensure') {
        const existing = [...store.values()].find(
          (rec) =>
            rec.workspaceId === input.workspaceId &&
            rec.hosting === 'managed' &&
            rec.status === 'active',
        )
        if (existing) return { assistant: existing, created: false }
      }
      const apiKey = generateAssistantApiKey()
      memoryCounter++
      const id = `asst-${memoryCounter}-${randomUUID()}`
      const rec = {
        id,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientInstallationId: `managed:${id}`,
        runtimeAssistantId: id,
        clientPlatform: 'cloud',
        assistantVersion: null,
        machineName: null,
        name: input.name ?? defaultName('managed'),
        description: input.description ?? null,
        hosting: 'managed' as const,
        status: 'active' as const,
        active: true,
        apiKeyHash: hashSecret(apiKey),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastSeenAt: nowIso(),
        retiredAt: null,
      }
      deactivateOthers(input.workspaceId, id)
      store.set(id, rec)
      return { assistant: rec, created: true }
    },
    async retire(workspaceId, assistantId) {
      const rec = store.get(assistantId)
      if (!rec || rec.workspaceId !== workspaceId) return { retired: false }
      store.set(assistantId, {
        ...rec,
        status: 'retired',
        active: false,
        retiredAt: nowIso(),
        updatedAt: nowIso(),
      })
      return { retired: true }
    },
    __reset() {
      store.clear()
      memoryCounter = 0
    },
  }
}

export function createDrizzleClientAssistantsRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): ClientAssistantsRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  async function deactivateOthers(workspaceId: string, activeId: string) {
    await db()
      .update(clientAssistantsTable)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(clientAssistantsTable.workspaceId, workspaceId),
          eq(clientAssistantsTable.active, true),
        ),
      )
    await db()
      .update(clientAssistantsTable)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(clientAssistantsTable.id, activeId))
  }

  async function getByLocalIdentity(input: EnsureLocalRegistrationInput) {
    const rows = await db()
      .select()
      .from(clientAssistantsTable)
      .where(
        and(
          eq(clientAssistantsTable.workspaceId, input.workspaceId),
          eq(clientAssistantsTable.clientInstallationId, input.clientInstallationId),
          eq(clientAssistantsTable.runtimeAssistantId, input.runtimeAssistantId),
          eq(clientAssistantsTable.status, 'active'),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRecord(rows[0] as ClientAssistant) : null
  }

  return {
    async list(input) {
      const filters = [
        eq(clientAssistantsTable.workspaceId, input.workspaceId),
        eq(clientAssistantsTable.status, 'active'),
      ]
      if (input.hosting) {
        filters.push(eq(clientAssistantsTable.hosting, input.hosting))
      }
      const rows = await db()
        .select()
        .from(clientAssistantsTable)
        .where(and(...filters))
        .orderBy(desc(clientAssistantsTable.createdAt))
      return (rows as ClientAssistant[]).map(rowToRecord)
    },
    async get(workspaceId, assistantId) {
      const rows = await db()
        .select()
        .from(clientAssistantsTable)
        .where(
          and(
            eq(clientAssistantsTable.id, assistantId),
            eq(clientAssistantsTable.workspaceId, workspaceId),
            eq(clientAssistantsTable.status, 'active'),
          ),
        )
        .limit(1)
      return rows[0] ? rowToRecord(rows[0] as ClientAssistant) : null
    },
    async getActive(workspaceId) {
      const rows = await db()
        .select()
        .from(clientAssistantsTable)
        .where(
          and(
            eq(clientAssistantsTable.workspaceId, workspaceId),
            eq(clientAssistantsTable.status, 'active'),
            eq(clientAssistantsTable.active, true),
          ),
        )
        .orderBy(desc(clientAssistantsTable.updatedAt))
        .limit(1)
      return rows[0] ? rowToRecord(rows[0] as ClientAssistant) : null
    },
    async activate(workspaceId, assistantId) {
      const rec = await this.get(workspaceId, assistantId)
      if (!rec) return null
      await deactivateOthers(workspaceId, assistantId)
      return this.get(workspaceId, assistantId)
    },
    async update(workspaceId, assistantId, patch) {
      const rec = await this.get(workspaceId, assistantId)
      if (!rec) return null
      await db()
        .update(clientAssistantsTable)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(clientAssistantsTable.id, assistantId))
      return this.get(workspaceId, assistantId)
    },
    async ensureLocalRegistration(input) {
      const existing = await getByLocalIdentity(input)
      if (existing) {
        await db()
          .update(clientAssistantsTable)
          .set({
            accountId: input.accountId,
            clientPlatform: input.clientPlatform,
            assistantVersion: input.assistantVersion ?? null,
            machineName: input.machineName ?? null,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(clientAssistantsTable.id, existing.id))
        const updated = await this.get(input.workspaceId, existing.id)
        return {
          assistant: updated ?? existing,
          assistantApiKey: null,
          webhookSecret: null,
        }
      }
      const apiKey = generateAssistantApiKey()
      const inserted = await db()
        .insert(clientAssistantsTable)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          clientInstallationId: input.clientInstallationId,
          runtimeAssistantId: input.runtimeAssistantId,
          clientPlatform: input.clientPlatform,
          assistantVersion: input.assistantVersion ?? null,
          machineName: input.machineName ?? null,
          name: defaultName('local', input.machineName),
          hosting: 'local',
          status: 'active',
          active: true,
          assistantApiKeyHash: hashSecret(apiKey),
        })
        .returning()
      const row = inserted[0] as ClientAssistant | undefined
      if (!row) throw new Error('client assistant insert returned no row')
      await deactivateOthers(input.workspaceId, row.id)
      const assistant = await this.get(input.workspaceId, row.id)
      return {
        assistant: assistant ?? rowToRecord(row),
        assistantApiKey: apiKey,
        webhookSecret: null,
      }
    },
    async reprovisionLocalRegistration(input) {
      const ensured = await this.ensureLocalRegistration(input)
      const apiKey = generateAssistantApiKey()
      await db()
        .update(clientAssistantsTable)
        .set({
          assistantApiKeyHash: hashSecret(apiKey),
          updatedAt: new Date(),
        })
        .where(eq(clientAssistantsTable.id, ensured.assistant.id))
      return {
        assistant:
          (await this.get(input.workspaceId, ensured.assistant.id)) ??
          ensured.assistant,
        assistantApiKey: apiKey,
        webhookSecret: null,
      }
    },
    async hatch(input) {
      if (input.mode === 'ensure') {
        const existing = await this.list({
          workspaceId: input.workspaceId,
          hosting: 'managed',
        })
        if (existing[0]) return { assistant: existing[0], created: false }
      }
      const apiKey = generateAssistantApiKey()
      const inserted = await db()
        .insert(clientAssistantsTable)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          clientInstallationId: `managed:${randomUUID()}`,
          runtimeAssistantId: randomUUID(),
          clientPlatform: 'cloud',
          name: input.name ?? defaultName('managed'),
          description: input.description ?? null,
          hosting: 'managed',
          status: 'active',
          active: true,
          assistantApiKeyHash: hashSecret(apiKey),
        })
        .returning()
      const row = inserted[0] as ClientAssistant | undefined
      if (!row) throw new Error('client assistant insert returned no row')
      await deactivateOthers(input.workspaceId, row.id)
      return {
        assistant: (await this.get(input.workspaceId, row.id)) ?? rowToRecord(row),
        created: true,
      }
    },
    async retire(workspaceId, assistantId) {
      const rec = await this.get(workspaceId, assistantId)
      if (!rec) return { retired: false }
      await db()
        .update(clientAssistantsTable)
        .set({
          status: 'retired',
          active: false,
          retiredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(clientAssistantsTable.id, assistantId))
      return { retired: true }
    },
  }
}

let repo: ClientAssistantsRepo = createDrizzleClientAssistantsRepo()

export function getClientAssistantsRepo(): ClientAssistantsRepo {
  return repo
}

export function __setClientAssistantsRepoForTests(next: ClientAssistantsRepo) {
  repo = next
}

export type DesktopAssistantHosting = ClientAssistantHosting
export type DesktopAssistantStatus = ClientAssistantStatus
export type DesktopAssistantRecord = ClientAssistantRecord
export type DesktopAssistantsRepo = ClientAssistantsRepo

export const createMemoryDesktopAssistantsRepo = createMemoryClientAssistantsRepo
export const createDrizzleDesktopAssistantsRepo = createDrizzleClientAssistantsRepo
export const getDesktopAssistantsRepo = getClientAssistantsRepo
export const __setDesktopAssistantsRepoForTests = __setClientAssistantsRepoForTests

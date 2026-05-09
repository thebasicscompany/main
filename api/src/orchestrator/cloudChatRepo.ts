import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import {
  runtimeConversations,
  runtimeMessages,
  type RuntimeConversation,
  type RuntimeMessage,
} from '../db/schema.js'

export type CloudChatConversation = {
  id: string
  workspaceId: string
  accountId: string
  assistantId: string
  clientConversationKey: string
  title: string
  source: string
  lastMessageAt: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export type CloudChatMessage = {
  id: string
  conversationId: string
  workspaceId: string
  accountId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata: Record<string, unknown>
  clientMessageId: string | null
  createdAt: string
  updatedAt: string
}

export interface CloudChatRepo {
  getOrCreateConversation(input: {
    workspaceId: string
    accountId: string
    assistantId: string
    clientConversationKey: string
    title: string
    source: string
  }): Promise<CloudChatConversation>
  listConversations(input: {
    workspaceId: string
    assistantId: string
    offset: number
    limit: number
  }): Promise<{ conversations: CloudChatConversation[]; hasMore: boolean; nextOffset: number | null }>
  getConversation(input: {
    workspaceId: string
    assistantId: string
    conversationId: string
  }): Promise<CloudChatConversation | null>
  renameConversation(input: {
    workspaceId: string
    assistantId: string
    conversationId: string
    title: string
  }): Promise<CloudChatConversation | null>
  addMessage(input: {
    conversationId: string
    workspaceId: string
    accountId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    metadata?: Record<string, unknown>
    clientMessageId?: string | null
  }): Promise<CloudChatMessage>
  listMessages(input: {
    workspaceId: string
    conversationId: string
    limit: number
    before?: Date
  }): Promise<{ messages: CloudChatMessage[]; hasMore: boolean }>
}

function iso(date: Date | null | undefined) {
  return date ? date.toISOString() : null
}

function conversationRowToRecord(row: RuntimeConversation): CloudChatConversation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    assistantId: row.assistantId,
    clientConversationKey: row.clientConversationKey,
    title: row.title,
    source: row.source,
    lastMessageAt: iso(row.lastMessageAt),
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function messageRowToRecord(row: RuntimeMessage): CloudChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    role: row.role as CloudChatMessage['role'],
    content: row.content,
    metadata: row.metadata ?? {},
    clientMessageId: row.clientMessageId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function nowIso() {
  return new Date().toISOString()
}

export function createMemoryCloudChatRepo(): CloudChatRepo & { __reset: () => void } {
  const conversations = new Map<string, CloudChatConversation>()
  const messages = new Map<string, CloudChatMessage>()

  return {
    async getOrCreateConversation(input) {
      const existing = [...conversations.values()].find(
        (c) =>
          c.workspaceId === input.workspaceId &&
          c.accountId === input.accountId &&
          c.assistantId === input.assistantId &&
          c.clientConversationKey === input.clientConversationKey,
      )
      if (existing) return existing
      const createdAt = nowIso()
      const conversation: CloudChatConversation = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        assistantId: input.assistantId,
        clientConversationKey: input.clientConversationKey,
        title: input.title,
        source: input.source,
        lastMessageAt: null,
        archived: false,
        createdAt,
        updatedAt: createdAt,
      }
      conversations.set(conversation.id, conversation)
      return conversation
    },
    async listConversations(input) {
      const rows = [...conversations.values()]
        .filter(
          (c) =>
            c.workspaceId === input.workspaceId &&
            c.assistantId === input.assistantId &&
            !c.archived,
        )
        .sort((a, b) => {
          const left = a.lastMessageAt ?? a.updatedAt
          const right = b.lastMessageAt ?? b.updatedAt
          return right.localeCompare(left)
        })
      const slice = rows.slice(input.offset, input.offset + input.limit + 1)
      const hasMore = slice.length > input.limit
      return {
        conversations: slice.slice(0, input.limit),
        hasMore,
        nextOffset: hasMore ? input.offset + input.limit : null,
      }
    },
    async getConversation(input) {
      const conversation = conversations.get(input.conversationId)
      if (
        !conversation ||
        conversation.workspaceId !== input.workspaceId ||
        conversation.assistantId !== input.assistantId
      ) {
        return null
      }
      return conversation
    },
    async renameConversation(input) {
      const conversation = await this.getConversation(input)
      if (!conversation) return null
      const updated = { ...conversation, title: input.title, updatedAt: nowIso() }
      conversations.set(updated.id, updated)
      return updated
    },
    async addMessage(input) {
      const createdAt = nowIso()
      const message: CloudChatMessage = {
        id: randomUUID(),
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? {},
        clientMessageId: input.clientMessageId ?? null,
        createdAt,
        updatedAt: createdAt,
      }
      messages.set(message.id, message)
      const conversation = conversations.get(input.conversationId)
      if (conversation) {
        conversations.set(conversation.id, {
          ...conversation,
          lastMessageAt: createdAt,
          updatedAt: createdAt,
        })
      }
      return message
    },
    async listMessages(input) {
      const rows = [...messages.values()]
        .filter((m) => {
          if (m.workspaceId !== input.workspaceId) return false
          if (m.conversationId !== input.conversationId) return false
          if (input.before && new Date(m.createdAt) >= input.before) return false
          return true
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const slice = rows.slice(0, input.limit + 1)
      return {
        messages: slice.slice(0, input.limit).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        hasMore: slice.length > input.limit,
      }
    },
    __reset() {
      conversations.clear()
      messages.clear()
    },
  }
}

export function createDrizzleCloudChatRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): CloudChatRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async getOrCreateConversation(input) {
      const rows = await db()
        .insert(runtimeConversations)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          assistantId: input.assistantId,
          clientConversationKey: input.clientConversationKey,
          title: input.title,
          source: input.source,
        })
        .onConflictDoUpdate({
          target: [
            runtimeConversations.workspaceId,
            runtimeConversations.accountId,
            runtimeConversations.assistantId,
            runtimeConversations.clientConversationKey,
          ],
          set: { updatedAt: new Date() },
        })
        .returning()
      return conversationRowToRecord(rows[0] as RuntimeConversation)
    },
    async listConversations(input) {
      const rows = await db()
        .select()
        .from(runtimeConversations)
        .where(
          and(
            eq(runtimeConversations.workspaceId, input.workspaceId),
            eq(runtimeConversations.assistantId, input.assistantId),
            eq(runtimeConversations.archived, false),
          ),
        )
        .orderBy(desc(runtimeConversations.lastMessageAt), desc(runtimeConversations.updatedAt))
        .limit(input.limit + 1)
        .offset(input.offset)
      const hasMore = rows.length > input.limit
      return {
        conversations: (rows.slice(0, input.limit) as RuntimeConversation[]).map(conversationRowToRecord),
        hasMore,
        nextOffset: hasMore ? input.offset + input.limit : null,
      }
    },
    async getConversation(input) {
      const rows = await db()
        .select()
        .from(runtimeConversations)
        .where(
          and(
            eq(runtimeConversations.id, input.conversationId),
            eq(runtimeConversations.workspaceId, input.workspaceId),
            eq(runtimeConversations.assistantId, input.assistantId),
          ),
        )
        .limit(1)
      return rows[0] ? conversationRowToRecord(rows[0] as RuntimeConversation) : null
    },
    async renameConversation(input) {
      const rows = await db()
        .update(runtimeConversations)
        .set({ title: input.title, updatedAt: new Date() })
        .where(
          and(
            eq(runtimeConversations.id, input.conversationId),
            eq(runtimeConversations.workspaceId, input.workspaceId),
            eq(runtimeConversations.assistantId, input.assistantId),
          ),
        )
        .returning()
      return rows[0] ? conversationRowToRecord(rows[0] as RuntimeConversation) : null
    },
    async addMessage(input) {
      const rows = await db()
        .insert(runtimeMessages)
        .values({
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          role: input.role,
          content: input.content,
          metadata: input.metadata ?? {},
          clientMessageId: input.clientMessageId ?? null,
        })
        .returning()
      await db()
        .update(runtimeConversations)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(runtimeConversations.id, input.conversationId))
      return messageRowToRecord(rows[0] as RuntimeMessage)
    },
    async listMessages(input) {
      const filters = [
        eq(runtimeMessages.workspaceId, input.workspaceId),
        eq(runtimeMessages.conversationId, input.conversationId),
      ]
      if (input.before) filters.push(lt(runtimeMessages.createdAt, input.before))
      const rows = await db()
        .select()
        .from(runtimeMessages)
        .where(and(...filters))
        .orderBy(desc(runtimeMessages.createdAt))
        .limit(input.limit + 1)
      const hasMore = rows.length > input.limit
      return {
        messages: (rows.slice(0, input.limit) as RuntimeMessage[])
          .map(messageRowToRecord)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        hasMore,
      }
    },
  }
}

let repoOverride: CloudChatRepo | null = null

export function getCloudChatRepo(): CloudChatRepo {
  return repoOverride ?? createDrizzleCloudChatRepo()
}

export function __setCloudChatRepoForTests(repo: CloudChatRepo | null): void {
  repoOverride = repo
}

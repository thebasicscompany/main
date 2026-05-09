import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, ilike, or } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from '../db/index.js'
import {
  clientMemoryConceptPages,
  clientMemoryItems,
  type ClientMemoryConceptPage,
  type ClientMemoryItem,
} from '../db/schema.js'

export type CloudMemoryItem = {
  id: string
  workspaceId: string
  accountId: string
  assistantId: string
  kind: string
  subject: string
  statement: string
  status: string
  confidence: number | null
  importance: number | null
  verificationState: string | null
  firstSeenAt: string
  lastSeenAt: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CloudConceptPage = {
  slug: string
  rendered: string
  bodyBytes: number
  edgeCount: number
  updatedAt: string
}

export type ListMemoryItemsInput = {
  workspaceId: string
  assistantId: string
  kind?: string
  status?: string
  search?: string
  sort: 'lastSeenAt' | 'importance' | 'kind' | 'firstSeenAt'
  order: 'asc' | 'desc'
  limit: number
  offset: number
}

export interface CloudMemoryRepo {
  listItems(input: ListMemoryItemsInput): Promise<{
    items: CloudMemoryItem[]
    total: number
    kindCounts: Record<string, number>
  }>
  getItem(input: {
    workspaceId: string
    assistantId: string
    id: string
  }): Promise<CloudMemoryItem | null>
  createItem(input: {
    workspaceId: string
    accountId: string
    assistantId: string
    kind: string
    subject: string
    statement: string
    importance?: number | null
  }): Promise<CloudMemoryItem>
  updateItem(input: {
    workspaceId: string
    assistantId: string
    id: string
    kind?: string
    subject?: string
    statement?: string
    status?: string
    importance?: number | null
    verificationState?: string | null
  }): Promise<CloudMemoryItem | null>
  deleteItem(input: {
    workspaceId: string
    assistantId: string
    id: string
  }): Promise<boolean>
  listConceptPages(input: {
    workspaceId: string
    assistantId: string
  }): Promise<CloudConceptPage[]>
  getConceptPage(input: {
    workspaceId: string
    assistantId: string
    slug: string
  }): Promise<CloudConceptPage | null>
}

function iso(date: Date | null | undefined) {
  return (date ?? new Date()).toISOString()
}

function rowToItem(row: ClientMemoryItem): CloudMemoryItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    assistantId: row.assistantId,
    kind: row.kind,
    subject: row.subject,
    statement: row.statement,
    status: row.status,
    confidence: row.confidence ?? null,
    importance: row.importance ?? null,
    verificationState: row.verificationState ?? null,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    metadata: row.metadata ?? {},
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

function rowToConceptPage(row: ClientMemoryConceptPage): CloudConceptPage {
  return {
    slug: row.slug,
    rendered: row.rendered,
    bodyBytes: row.bodyBytes,
    edgeCount: row.edgeCount,
    updatedAt: iso(row.updatedAt),
  }
}

function itemMatches(input: ListMemoryItemsInput, item: CloudMemoryItem): boolean {
  if (item.workspaceId !== input.workspaceId) return false
  if (item.assistantId !== input.assistantId) return false
  if (input.status && input.status !== 'all' && item.status !== input.status) {
    return false
  }
  if (input.kind && item.kind !== input.kind) return false
  if (input.search) {
    const needle = input.search.toLowerCase()
    return (
      item.subject.toLowerCase().includes(needle) ||
      item.statement.toLowerCase().includes(needle)
    )
  }
  return true
}

function sortItems(
  items: CloudMemoryItem[],
  sort: ListMemoryItemsInput['sort'],
  order: ListMemoryItemsInput['order'],
) {
  const factor = order === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    let left: string | number
    let right: string | number
    switch (sort) {
      case 'firstSeenAt':
        left = Date.parse(a.firstSeenAt)
        right = Date.parse(b.firstSeenAt)
        break
      case 'importance':
        left = a.importance ?? 0
        right = b.importance ?? 0
        break
      case 'kind':
        left = a.kind
        right = b.kind
        break
      case 'lastSeenAt':
      default:
        left = Date.parse(a.lastSeenAt)
        right = Date.parse(b.lastSeenAt)
        break
    }
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).localeCompare(String(right)) * factor
    }
    return (left - right) * factor
  })
}

function kindCountsFor(items: CloudMemoryItem[]) {
  const counts: Record<string, number> = {}
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
  return counts
}

export function createMemoryCloudMemoryRepo(): CloudMemoryRepo & {
  __reset: () => void
  __upsertConceptPage: (input: {
    workspaceId: string
    accountId: string
    assistantId: string
    slug: string
    rendered: string
    edgeCount?: number
  }) => void
} {
  const items = new Map<string, CloudMemoryItem>()
  const pages = new Map<string, CloudConceptPage & {
    workspaceId: string
    accountId: string
    assistantId: string
  }>()

  return {
    async listItems(input) {
      const filtered = [...items.values()].filter((item) =>
        itemMatches(input, item),
      )
      const counts = kindCountsFor(
        [...items.values()].filter(
          (item) =>
            item.workspaceId === input.workspaceId &&
            item.assistantId === input.assistantId &&
            (!input.status ||
              input.status === 'all' ||
              item.status === input.status) &&
            (!input.search ||
              item.subject.toLowerCase().includes(input.search.toLowerCase()) ||
              item.statement
                .toLowerCase()
                .includes(input.search.toLowerCase())),
        ),
      )
      return {
        items: sortItems(filtered, input.sort, input.order).slice(
          input.offset,
          input.offset + input.limit,
        ),
        total: filtered.length,
        kindCounts: counts,
      }
    },
    async getItem(input) {
      const item = items.get(input.id)
      if (
        !item ||
        item.workspaceId !== input.workspaceId ||
        item.assistantId !== input.assistantId
      ) {
        return null
      }
      return item
    },
    async createItem(input) {
      const now = new Date().toISOString()
      const item: CloudMemoryItem = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        assistantId: input.assistantId,
        kind: input.kind,
        subject: input.subject,
        statement: input.statement,
        status: 'active',
        confidence: null,
        importance: input.importance ?? null,
        verificationState: 'user_confirmed',
        firstSeenAt: now,
        lastSeenAt: now,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      }
      items.set(item.id, item)
      return item
    },
    async updateItem(input) {
      const current = await this.getItem(input)
      if (!current) return null
      const updated: CloudMemoryItem = {
        ...current,
        kind: input.kind ?? current.kind,
        subject: input.subject ?? current.subject,
        statement: input.statement ?? current.statement,
        status: input.status ?? current.status,
        importance:
          Object.prototype.hasOwnProperty.call(input, 'importance')
            ? (input.importance ?? null)
            : current.importance,
        verificationState:
          Object.prototype.hasOwnProperty.call(input, 'verificationState')
            ? (input.verificationState ?? null)
            : current.verificationState,
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      items.set(updated.id, updated)
      return updated
    },
    async deleteItem(input) {
      const current = await this.getItem(input)
      if (!current) return false
      items.delete(input.id)
      return true
    },
    async listConceptPages(input) {
      return [...pages.values()]
        .filter(
          (page) =>
            page.workspaceId === input.workspaceId &&
            page.assistantId === input.assistantId,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    async getConceptPage(input) {
      const page = pages.get(`${input.workspaceId}:${input.assistantId}:${input.slug}`)
      if (!page) return null
      return page
    },
    __reset() {
      items.clear()
      pages.clear()
    },
    __upsertConceptPage(input) {
      const now = new Date().toISOString()
      pages.set(`${input.workspaceId}:${input.assistantId}:${input.slug}`, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        assistantId: input.assistantId,
        slug: input.slug,
        rendered: input.rendered,
        bodyBytes: Buffer.byteLength(input.rendered, 'utf8'),
        edgeCount: input.edgeCount ?? 0,
        updatedAt: now,
      })
    },
  }
}

export function createDrizzleCloudMemoryRepo(
  dbOverride?: PostgresJsDatabase<Record<string, unknown>>,
): CloudMemoryRepo {
  const db = () =>
    dbOverride ??
    (getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>)

  return {
    async listItems(input) {
      const filters = [
        eq(clientMemoryItems.workspaceId, input.workspaceId),
        eq(clientMemoryItems.assistantId, input.assistantId),
      ]
      if (input.status && input.status !== 'all') {
        filters.push(eq(clientMemoryItems.status, input.status))
      }
      if (input.kind) filters.push(eq(clientMemoryItems.kind, input.kind))
      if (input.search) {
        filters.push(
          or(
            ilike(clientMemoryItems.subject, `%${input.search}%`),
            ilike(clientMemoryItems.statement, `%${input.search}%`),
          )!,
        )
      }

      const orderColumn =
        input.sort === 'firstSeenAt'
          ? clientMemoryItems.firstSeenAt
          : input.sort === 'importance'
            ? clientMemoryItems.importance
            : input.sort === 'kind'
              ? clientMemoryItems.kind
              : clientMemoryItems.lastSeenAt
      const orderBy = input.order === 'asc' ? asc(orderColumn) : desc(orderColumn)

      const rows = await db()
        .select()
        .from(clientMemoryItems)
        .where(and(...filters))
        .orderBy(orderBy)
        .limit(input.limit)
        .offset(input.offset)

      const totalRows = await db()
        .select({ value: count() })
        .from(clientMemoryItems)
        .where(and(...filters))

      const countFilters = [
        eq(clientMemoryItems.workspaceId, input.workspaceId),
        eq(clientMemoryItems.assistantId, input.assistantId),
      ]
      if (input.status && input.status !== 'all') {
        countFilters.push(eq(clientMemoryItems.status, input.status))
      }
      if (input.search) {
        countFilters.push(
          or(
            ilike(clientMemoryItems.subject, `%${input.search}%`),
            ilike(clientMemoryItems.statement, `%${input.search}%`),
          )!,
        )
      }
      const allForCounts = await db()
        .select()
        .from(clientMemoryItems)
        .where(and(...countFilters))

      return {
        items: (rows as ClientMemoryItem[]).map(rowToItem),
        total: Number(totalRows[0]?.value ?? 0),
        kindCounts: kindCountsFor((allForCounts as ClientMemoryItem[]).map(rowToItem)),
      }
    },
    async getItem(input) {
      const rows = await db()
        .select()
        .from(clientMemoryItems)
        .where(
          and(
            eq(clientMemoryItems.id, input.id),
            eq(clientMemoryItems.workspaceId, input.workspaceId),
            eq(clientMemoryItems.assistantId, input.assistantId),
          ),
        )
        .limit(1)
      return rows[0] ? rowToItem(rows[0] as ClientMemoryItem) : null
    },
    async createItem(input) {
      const rows = await db()
        .insert(clientMemoryItems)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          assistantId: input.assistantId,
          kind: input.kind,
          subject: input.subject,
          statement: input.statement,
          importance: input.importance ?? null,
          verificationState: 'user_confirmed',
        })
        .returning()
      return rowToItem(rows[0] as ClientMemoryItem)
    },
    async updateItem(input) {
      const values: Partial<typeof clientMemoryItems.$inferInsert> = {
        updatedAt: new Date(),
        lastSeenAt: new Date(),
      }
      if (input.kind !== undefined) values.kind = input.kind
      if (input.subject !== undefined) values.subject = input.subject
      if (input.statement !== undefined) values.statement = input.statement
      if (input.status !== undefined) values.status = input.status
      if (Object.prototype.hasOwnProperty.call(input, 'importance')) {
        values.importance = input.importance ?? null
      }
      if (Object.prototype.hasOwnProperty.call(input, 'verificationState')) {
        values.verificationState = input.verificationState ?? null
      }
      const rows = await db()
        .update(clientMemoryItems)
        .set(values)
        .where(
          and(
            eq(clientMemoryItems.id, input.id),
            eq(clientMemoryItems.workspaceId, input.workspaceId),
            eq(clientMemoryItems.assistantId, input.assistantId),
          ),
        )
        .returning()
      return rows[0] ? rowToItem(rows[0] as ClientMemoryItem) : null
    },
    async deleteItem(input) {
      const rows = await db()
        .delete(clientMemoryItems)
        .where(
          and(
            eq(clientMemoryItems.id, input.id),
            eq(clientMemoryItems.workspaceId, input.workspaceId),
            eq(clientMemoryItems.assistantId, input.assistantId),
          ),
        )
        .returning({ id: clientMemoryItems.id })
      return rows.length > 0
    },
    async listConceptPages(input) {
      const rows = await db()
        .select()
        .from(clientMemoryConceptPages)
        .where(
          and(
            eq(clientMemoryConceptPages.workspaceId, input.workspaceId),
            eq(clientMemoryConceptPages.assistantId, input.assistantId),
          ),
        )
        .orderBy(desc(clientMemoryConceptPages.updatedAt))
      return (rows as ClientMemoryConceptPage[]).map(rowToConceptPage)
    },
    async getConceptPage(input) {
      const rows = await db()
        .select()
        .from(clientMemoryConceptPages)
        .where(
          and(
            eq(clientMemoryConceptPages.workspaceId, input.workspaceId),
            eq(clientMemoryConceptPages.assistantId, input.assistantId),
            eq(clientMemoryConceptPages.slug, input.slug),
          ),
        )
        .limit(1)
      return rows[0] ? rowToConceptPage(rows[0] as ClientMemoryConceptPage) : null
    },
  }
}

let repoOverride: CloudMemoryRepo | null = null

export function getCloudMemoryRepo(): CloudMemoryRepo {
  return repoOverride ?? createDrizzleCloudMemoryRepo()
}

export function __setCloudMemoryRepoForTests(repo: CloudMemoryRepo | null): void {
  repoOverride = repo
}

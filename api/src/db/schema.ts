import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Reserved Postgres schema namespace for runtime-API-owned tables.
 *
 * After Phase 2 cleanup the runtime schema holds backend-owned runtime tables
 * only. Client-owned assistant/chat state lives in public.client_* tables.
 *
 * The cloud-agent core lives in `public.cloud_*` (Phase H).
 */
export const runtime = pgSchema('runtime')

/**
 * Append-only metering. Control plane and worker both write rows.
 */
export const usageEvents = runtime.table(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id'),
    kind: text('kind').notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 4 }).notNull(),
    unit: text('unit').notNull(),
    cents: numeric('cents', { precision: 20, scale: 4 }),
    provider: text('provider'),
    model: text('model'),
    runId: uuid('run_id'),
    metadata: jsonb('metadata'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('usage_events_ws_kind_time_idx').on(
      t.workspaceId,
      t.kind,
      t.occurredAt,
    ),
    index('usage_events_run_idx').on(t.runId),
  ],
)

/**
 * Client assistant registrations. Workspace JWTs authorize control-plane
 * calls; the generated assistant credential is scoped to the registered
 * assistant and can be rotated or retired independently.
 */
export const clientAssistants = pgTable(
  'client_assistants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientInstallationId: text('client_installation_id').notNull(),
    runtimeAssistantId: text('runtime_assistant_id').notNull(),
    clientPlatform: text('client_platform').notNull(),
    assistantVersion: text('assistant_version'),
    machineName: text('machine_name'),
    name: text('name'),
    description: text('description'),
    hosting: text('hosting').notNull().default('local'),
    status: text('status').notNull().default('active'),
    active: boolean('active').notNull().default(true),
    assistantApiKeyHash: text('assistant_api_key_hash').notNull(),
    webhookSecretHash: text('webhook_secret_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('client_assistants_ws_install_runtime_key').on(
      t.workspaceId,
      t.clientInstallationId,
      t.runtimeAssistantId,
    ),
    index('client_assistants_workspace_status_idx').on(
      t.workspaceId,
      t.status,
    ),
    index('client_assistants_workspace_active_idx').on(
      t.workspaceId,
      t.active,
    ),
  ],
)

/**
 * Desktop-chat conversations. The desktop client owns local conversation
 * identifiers; the API stores a deterministic mapping from that client key
 * to a server-owned UUID per workspace/account/assistant.
 */
export const clientConversations = pgTable(
  'client_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    clientConversationKey: text('client_conversation_key').notNull(),
    title: text('title').notNull(),
    source: text('source').notNull().default('macos'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('client_conversations_ws_acct_asst_client_key').on(
      t.workspaceId,
      t.accountId,
      t.assistantId,
      t.clientConversationKey,
    ),
    index('client_conversations_ws_asst_last_message_idx').on(
      t.workspaceId,
      t.assistantId,
      t.lastMessageAt,
    ),
    index('client_conversations_ws_asst_archived_idx').on(
      t.workspaceId,
      t.assistantId,
      t.archived,
    ),
  ],
)

/** Desktop-chat messages. */
export const clientMessages = pgTable(
  'client_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => clientConversations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    clientMessageId: text('client_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('client_messages_conversation_created_idx').on(
      t.conversationId,
      t.createdAt,
    ),
    index('client_messages_ws_asst_conversation_idx').on(
      t.workspaceId,
      t.conversationId,
    ),
    uniqueIndex('client_messages_conversation_client_message_key').on(
      t.conversationId,
      t.clientMessageId,
    ),
  ],
)

/** Client-owned memory facts for managed cloud assistants. */
export const clientMemoryItems = pgTable(
  'client_memory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    statement: text('statement').notNull(),
    status: text('status').notNull().default('active'),
    confidence: doublePrecision('confidence'),
    importance: doublePrecision('importance'),
    verificationState: text('verification_state'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('client_memory_items_ws_asst_status_idx').on(
      t.workspaceId,
      t.assistantId,
      t.status,
    ),
    index('client_memory_items_ws_asst_kind_idx').on(
      t.workspaceId,
      t.assistantId,
      t.kind,
    ),
    index('client_memory_items_ws_asst_last_seen_idx').on(
      t.workspaceId,
      t.assistantId,
      t.lastSeenAt,
    ),
  ],
)

/** Provenance attached to managed cloud memory facts. */
export const clientMemorySources = pgTable(
  'client_memory_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    memoryItemId: uuid('memory_item_id')
      .notNull()
      .references(() => clientMemoryItems.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('client_memory_sources_item_idx').on(t.memoryItemId),
    index('client_memory_sources_ws_asst_idx').on(t.workspaceId, t.assistantId),
  ],
)

/** Relationship edges for the managed cloud memory map. */
export const clientMemoryEdges = pgTable(
  'client_memory_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    fromMemoryItemId: uuid('from_memory_item_id')
      .notNull()
      .references(() => clientMemoryItems.id, { onDelete: 'cascade' }),
    toMemoryItemId: uuid('to_memory_item_id')
      .notNull()
      .references(() => clientMemoryItems.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull().default('related'),
    weight: doublePrecision('weight'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('client_memory_edges_from_idx').on(t.fromMemoryItemId),
    index('client_memory_edges_to_idx').on(t.toMemoryItemId),
    uniqueIndex('client_memory_edges_unique_relation').on(
      t.workspaceId,
      t.assistantId,
      t.fromMemoryItemId,
      t.toMemoryItemId,
      t.relation,
    ),
  ],
)

/** Memory v2 concept-page bodies and summaries for managed cloud assistants. */
export const clientMemoryConceptPages = pgTable(
  'client_memory_concept_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    rendered: text('rendered').notNull(),
    bodyBytes: integer('body_bytes').notNull().default(0),
    edgeCount: integer('edge_count').notNull().default(0),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('client_memory_concept_pages_ws_asst_slug_key').on(
      t.workspaceId,
      t.assistantId,
      t.slug,
    ),
    index('client_memory_concept_pages_ws_asst_updated_idx').on(
      t.workspaceId,
      t.assistantId,
      t.updatedAt,
    ),
  ],
)

/** Optional vector references for managed cloud memory rows. */
export const clientMemoryEmbeddings = pgTable(
  'client_memory_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    vectorRef: text('vector_ref').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('client_memory_embeddings_owner_key').on(
      t.workspaceId,
      t.assistantId,
      t.ownerType,
      t.ownerId,
      t.provider,
      t.model,
    ),
  ],
)

/** Cross-device client settings that are safe to persist in managed cloud. */
export const clientSettings = pgTable(
  'client_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    assistantId: uuid('assistant_id').references(() => clientAssistants.id, {
      onDelete: 'cascade',
    }),
    scope: text('scope').notNull(),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('client_settings_scope_key').on(
      t.workspaceId,
      t.accountId,
      t.assistantId,
      t.scope,
    ),
  ],
)

/** Assistant-specific profile state for managed cloud clients. */
export const clientAssistantProfiles = pgTable(
  'client_assistant_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => clientAssistants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('client_assistant_profiles_name_key').on(
      t.workspaceId,
      t.assistantId,
      t.name,
    ),
    index('client_assistant_profiles_active_idx').on(
      t.workspaceId,
      t.assistantId,
      t.active,
    ),
  ],
)

export type UsageEvent = typeof usageEvents.$inferSelect
export type NewUsageEvent = typeof usageEvents.$inferInsert
export type ClientAssistant = typeof clientAssistants.$inferSelect
export type NewClientAssistant = typeof clientAssistants.$inferInsert
export type ClientConversation = typeof clientConversations.$inferSelect
export type NewClientConversation = typeof clientConversations.$inferInsert
export type ClientMessage = typeof clientMessages.$inferSelect
export type NewClientMessage = typeof clientMessages.$inferInsert
export type ClientMemoryItem = typeof clientMemoryItems.$inferSelect
export type NewClientMemoryItem = typeof clientMemoryItems.$inferInsert
export type ClientMemoryConceptPage =
  typeof clientMemoryConceptPages.$inferSelect

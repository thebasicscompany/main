import {
  boolean,
  index,
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

export type UsageEvent = typeof usageEvents.$inferSelect
export type NewUsageEvent = typeof usageEvents.$inferInsert
export type ClientAssistant = typeof clientAssistants.$inferSelect
export type NewClientAssistant = typeof clientAssistants.$inferInsert
export type ClientConversation = typeof clientConversations.$inferSelect
export type NewClientConversation = typeof clientConversations.$inferInsert
export type ClientMessage = typeof clientMessages.$inferSelect
export type NewClientMessage = typeof clientMessages.$inferInsert

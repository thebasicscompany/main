/**
 * Control-plane tables in `public.*` managed by this repo (Basics Cloud M4/M6).
 * Kept separate from `schema.ts` (`runtime.*`) and from the slim `workspaces.ts`
 * shim used for Browserbase columns only.
 */

import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const workspaceInvites = pgTable(
  'workspace_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    invitedEmail: text('invited_email').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    role: text('role').notNull(),
    token: text('token').notNull().unique(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAccountId: uuid('accepted_account_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('workspace_invites_email_idx').on(t.invitedEmail),
    index('workspace_invites_workspace_idx').on(t.workspaceId),
  ],
)

export const workspaceCredentials = pgTable(
  'workspace_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull().default(''),
    provenance: text('provenance').notNull(),
    status: text('status').notNull(),
    ciphertext: bytea('ciphertext'),
    kmsKeyId: text('kms_key_id').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastProviderError: text('last_provider_error'),
    lastProviderErrorAt: timestamp('last_provider_error_at', {
      withTimezone: true,
    }),
  },
  (t) => [
    uniqueIndex('workspace_credentials_unique_kind_label').on(
      t.workspaceId,
      t.kind,
      t.label,
    ),
    index('workspace_credentials_workspace_active').on(t.workspaceId, t.status),
    check(
      'workspace_credentials_provenance_check',
      sql`${t.provenance} IN ('basics_managed', 'customer_byok')`,
    ),
    check(
      'workspace_credentials_status_check',
      sql`${t.status} IN ('active', 'not_provisioned', 'cleared')`,
    ),
    check(
      'workspace_credentials_active_has_ciphertext',
      sql`${t.status} <> 'active' OR ${t.ciphertext} IS NOT NULL`,
    ),
  ],
)

export const workspaceApiKeys = pgTable(
  'workspace_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('active'),
    createdByAccountId: uuid('created_by_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex('workspace_api_keys_prefix_unique').on(t.prefix),
    index('workspace_api_keys_workspace_status').on(t.workspaceId, t.status),
    index('workspace_api_keys_workspace_metadata').using('gin', t.metadata),
    check(
      'workspace_api_keys_status_check',
      sql`${t.status} IN ('active', 'revoked')`,
    ),
  ],
)

export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect
export type WorkspaceCredentialRow = typeof workspaceCredentials.$inferSelect
export type WorkspaceApiKeyRow = typeof workspaceApiKeys.$inferSelect

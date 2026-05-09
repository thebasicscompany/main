/**
 * Phase 07 — read/write Drizzle binding for `public.workspaces`.
 *
 * `public.workspaces` is owned by `agent/` (its schema lives in
 * `agent/packages/db/src/schema.ts:511`). Phase 07 reuses two columns
 * already on this table — `browserbase_profile_id` and `last_cookie_sync_at`
 * — instead of introducing a new `runtime_contexts` table.
 *
 * This binding lives OUTSIDE `db/schema.ts` on purpose. The drizzle-kit
 * config (`drizzle.config.ts`) reads schema from `./src/db/schema.ts`. By
 * declaring the workspaces table here, drizzle-kit never sees it, never
 * proposes a migration that creates / alters it, and the runtime stays
 * out of agent/'s territory while still querying the table at runtime.
 *
 * The columns we read/write:
 *   - `browserbase_profile_id` — historical name, stores the Browserbase
 *     Context id (pre-Contexts agent/ created Browserbase Profiles).
 *   - `last_cookie_sync_at` — wall-clock timestamp of the last sync.
 */

import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name'),
  browserbaseProfileId: text('browserbase_profile_id'),
  lastCookieSyncAt: timestamp('last_cookie_sync_at', { withTimezone: true }),
})

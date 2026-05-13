-- F.1 — Per-automation state row for self-hosted polling of managed-auth
-- Composio triggers. Applied to production via Supabase MCP migration
-- `automations_f1_poll_state` on 2026-05-13; mirrored here so the
-- Drizzle history stays the canonical record. All statements use
-- IF NOT EXISTS / OR REPLACE so re-applying is a no-op.
--
-- The cron-kicker (F.2) reads from this table on a 2-min schedule,
-- dispatches to a per-toolkit adapter (F.3-F.8), and routes deltas
-- through the existing composio-trigger-router (D.5).
--
-- Composio's own webhook delivery still serves push-type triggers
-- (Slack, Linear, Asana, GitHub-webhook, Notion real-time). This table
-- only holds rows for trigger types Composio polls, where we've
-- decided to self-host the polling on a faster cadence than Composio's
-- 15-minute managed-auth floor.

CREATE TABLE IF NOT EXISTS "composio_poll_state" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id"          uuid NOT NULL,
  "trigger_index"          integer NOT NULL,
  "toolkit"                text NOT NULL,
  "event"                  text NOT NULL,
  "filters"                jsonb NOT NULL DEFAULT '{}'::jsonb,
  "state"                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "composio_user_id"       text NOT NULL,
  "connected_account_id"   text NOT NULL,
  "last_polled_at"         timestamp with time zone,
  "next_poll_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "consecutive_failures"   integer NOT NULL DEFAULT 0,
  "paused_at"              timestamp with time zone,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "composio_poll_state_automation_id_automations_id_fk"
    FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade,
  CONSTRAINT "composio_poll_state_unique_per_trigger"
    UNIQUE ("automation_id", "trigger_index")
);

CREATE INDEX IF NOT EXISTS "composio_poll_state_next_due_idx"
  ON "composio_poll_state" ("next_poll_at")
  WHERE "paused_at" IS NULL;

CREATE INDEX IF NOT EXISTS "composio_poll_state_automation_idx"
  ON "composio_poll_state" ("automation_id");

ALTER TABLE "composio_poll_state" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "composio_poll_state_select_workspace_member"
  ON "composio_poll_state";

CREATE POLICY "composio_poll_state_select_workspace_member"
  ON "composio_poll_state"
  FOR SELECT
  USING (
    automation_id IN (
      SELECT a.id
        FROM public.automations a
        JOIN public.workspace_members wm ON wm.workspace_id = a.workspace_id
        JOIN public.accounts ac ON ac.id = wm.account_id
       WHERE ac.supabase_auth_id = ((SELECT auth.uid()))::text
         AND wm.seat_status = 'active'
    )
  );

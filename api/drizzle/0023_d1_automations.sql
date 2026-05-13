-- D.1 — Trigger infrastructure: automations + automation_versions
-- + composio_triggers + trigger_event_log + cloud_runs column additions.
-- Applied to production via Supabase MCP migration `automations_d1_core`
-- on 2026-05-13; mirrored here so the Drizzle history stays the canonical
-- record. Per AUTOMATIONS-PLAN §5.3 + §7. accounts(id) is the FK target
-- (the schema doc references `users` loosely; this project uses accounts).

-- ─── automations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "automations" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"    uuid NOT NULL,
  "name"            text NOT NULL,
  "description"     text,
  "goal"            text NOT NULL,
  "context"         jsonb,
  "outputs"         jsonb NOT NULL DEFAULT '[]'::jsonb,
  "triggers"        jsonb NOT NULL DEFAULT '[]'::jsonb,
  "approval_policy" jsonb,
  "version"         integer NOT NULL DEFAULT 1,
  "created_by"      uuid NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at"     timestamp with time zone,
  CONSTRAINT "automations_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  CONSTRAINT "automations_created_by_accounts_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id")
);

CREATE INDEX IF NOT EXISTS "automations_workspace_active_idx"
  ON "automations" ("workspace_id") WHERE "archived_at" IS NULL;

ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "automations_select_workspace_member" ON "automations";
CREATE POLICY "automations_select_workspace_member"
  ON "automations" FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      JOIN public.accounts a ON a.id = wm.account_id
      WHERE a.supabase_auth_id = ((SELECT auth.uid()))::text
        AND wm.seat_status = 'active'
    )
  );

-- ─── automation_versions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "automation_versions" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id"  uuid NOT NULL,
  "version"        integer NOT NULL,
  "snapshot_json"  jsonb NOT NULL,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "automation_versions_automation_id_automations_id_fk"
    FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade,
  CONSTRAINT "automation_versions_unique" UNIQUE ("automation_id", "version")
);

ALTER TABLE "automation_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "automation_versions_select_workspace_member" ON "automation_versions";
CREATE POLICY "automation_versions_select_workspace_member"
  ON "automation_versions" FOR SELECT
  USING (
    automation_id IN (
      SELECT a.id FROM public.automations a
      JOIN public.workspace_members wm ON wm.workspace_id = a.workspace_id
      JOIN public.accounts ac ON ac.id = wm.account_id
      WHERE ac.supabase_auth_id = ((SELECT auth.uid()))::text
        AND wm.seat_status = 'active'
    )
  );

-- ─── composio_triggers ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "composio_triggers" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id"       uuid NOT NULL,
  "composio_trigger_id" text NOT NULL,
  "toolkit"             text NOT NULL,
  "event_type"          text NOT NULL,
  "filters"             jsonb,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "composio_triggers_automation_id_automations_id_fk"
    FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade,
  CONSTRAINT "composio_triggers_composio_trigger_id_unique" UNIQUE ("composio_trigger_id")
);

CREATE INDEX IF NOT EXISTS "composio_triggers_composio_trigger_id_idx"
  ON "composio_triggers" ("composio_trigger_id");

ALTER TABLE "composio_triggers" ENABLE ROW LEVEL SECURITY;

-- ─── trigger_event_log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "trigger_event_log" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id"  uuid NOT NULL,
  "trigger_index"  integer NOT NULL,
  "payload"        jsonb NOT NULL,
  "received_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"     timestamp with time zone NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT "trigger_event_log_automation_id_automations_id_fk"
    FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "trigger_event_log_expires_idx"
  ON "trigger_event_log" ("expires_at");
CREATE INDEX IF NOT EXISTS "trigger_event_log_automation_received_idx"
  ON "trigger_event_log" ("automation_id", "received_at" DESC);

ALTER TABLE "trigger_event_log" ENABLE ROW LEVEL SECURITY;

-- ─── cloud_runs column additions ──────────────────────────────────────────
-- Additive only; existing rows keep NULL/default values.
ALTER TABLE "cloud_runs"
  ADD COLUMN IF NOT EXISTS "automation_id"      uuid,
  ADD COLUMN IF NOT EXISTS "automation_version" integer,
  ADD COLUMN IF NOT EXISTS "triggered_by"       text,
  ADD COLUMN IF NOT EXISTS "inputs"             jsonb DEFAULT '{}'::jsonb;

ALTER TABLE "cloud_runs"
  ADD CONSTRAINT "cloud_runs_automation_id_automations_id_fk"
  FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id");

ALTER TABLE "cloud_runs"
  ADD CONSTRAINT "cloud_runs_triggered_by_check"
  CHECK ("triggered_by" IS NULL OR "triggered_by" IN ('manual','schedule','composio_webhook'));

CREATE INDEX IF NOT EXISTS "cloud_runs_automation_idx"
  ON "cloud_runs" ("automation_id", "created_at" DESC) WHERE "automation_id" IS NOT NULL;

-- ─── pg_cron reaper for trigger_event_log (7-day TTL) ─────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('reap-trigger-event-log');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'reap-trigger-event-log',
  '0 3 * * *',
  $$ DELETE FROM public.trigger_event_log WHERE expires_at < now() $$
);

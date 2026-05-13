-- B.2 — Composio worker unification tables.
-- Applied to production via Supabase MCP migration
-- `automations_b2_composio_tables` on 2026-05-13; mirrored here so the
-- Drizzle history stays the canonical record.
-- All statements use IF NOT EXISTS / CREATE OR REPLACE so re-applying
-- is a no-op.

CREATE TABLE IF NOT EXISTS "composio_tool_cache" (
  "workspace_id"   uuid NOT NULL,
  "toolkit_slug"   text NOT NULL,
  "tools_json"     jsonb NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "fetched_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "composio_tool_cache_pkey"
    PRIMARY KEY ("workspace_id", "toolkit_slug"),
  CONSTRAINT "composio_tool_cache_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS "external_action_audit" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id"       uuid NOT NULL,
  "tool_slug"    text NOT NULL,
  "params_full"  jsonb NOT NULL,
  "result"       jsonb,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at"   timestamp with time zone DEFAULT (now() + interval '30 days') NOT NULL
);

CREATE INDEX IF NOT EXISTS "external_action_audit_workspace_run_idx"
  ON "external_action_audit" ("workspace_id", "run_id");
CREATE INDEX IF NOT EXISTS "external_action_audit_expires_at_idx"
  ON "external_action_audit" ("expires_at");

ALTER TABLE "composio_tool_cache"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_action_audit" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "composio_tool_cache_select_workspace_member" ON "composio_tool_cache";
CREATE POLICY "composio_tool_cache_select_workspace_member"
  ON "composio_tool_cache"
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      JOIN accounts a ON a.id = wm.account_id
      WHERE a.supabase_auth_id = ((SELECT auth.uid()))::text
        AND wm.seat_status = 'active'
    )
  );

DROP POLICY IF EXISTS "external_action_audit_select_workspace_member" ON "external_action_audit";
CREATE POLICY "external_action_audit_select_workspace_member"
  ON "external_action_audit"
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      JOIN accounts a ON a.id = wm.account_id
      WHERE a.supabase_auth_id = ((SELECT auth.uid()))::text
        AND wm.seat_status = 'active'
    )
  );

-- Nightly reaper for expired audit rows (pg_cron).
-- Idempotent: unschedule any prior version before re-creating.
DO $$
BEGIN
  PERFORM cron.unschedule('reap-external-action-audit');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'reap-external-action-audit',
  '17 4 * * *',
  $$ DELETE FROM public.external_action_audit WHERE expires_at < now() $$
);

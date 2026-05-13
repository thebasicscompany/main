-- E.1 — Per-workspace saved browser context for sites that require login.
-- Applied to production via Supabase MCP migration `automations_e1_browser_sites`
-- on 2026-05-13; mirrored here so the Drizzle history stays the canonical record.
-- All statements use IF NOT EXISTS / OR REPLACE so re-applying is a no-op.

CREATE TABLE IF NOT EXISTS "workspace_browser_sites" (
  "workspace_id"        uuid NOT NULL,
  "host"                text NOT NULL,
  "display_name"        text,
  "storage_state_json"  jsonb NOT NULL,
  "captured_via"        text NOT NULL,
  "last_verified_at"    timestamp with time zone,
  "expires_at"          timestamp with time zone NOT NULL DEFAULT (now() + interval '60 days'),
  "created_by"          uuid,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_browser_sites_pkey" PRIMARY KEY ("workspace_id", "host"),
  CONSTRAINT "workspace_browser_sites_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  CONSTRAINT "workspace_browser_sites_created_by_accounts_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE set null,
  CONSTRAINT "workspace_browser_sites_captured_via_check"
    CHECK ("captured_via" IN ('browserbase_liveview','sync_local_profile','manual_upload')),
  CONSTRAINT "workspace_browser_sites_host_check"
    CHECK ("host" ~ '^[a-z0-9.-]+$')
);

CREATE INDEX IF NOT EXISTS "workspace_browser_sites_expires_at_idx"
  ON "workspace_browser_sites" ("expires_at");

ALTER TABLE "workspace_browser_sites" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_browser_sites_select_workspace_member"
  ON "workspace_browser_sites";

CREATE POLICY "workspace_browser_sites_select_workspace_member"
  ON "workspace_browser_sites"
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

CREATE OR REPLACE FUNCTION "public"."set_workspace_browser_sites_updated_at"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "workspace_browser_sites_updated_at"
  ON "workspace_browser_sites";

CREATE TRIGGER "workspace_browser_sites_updated_at"
  BEFORE UPDATE ON "workspace_browser_sites"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."set_workspace_browser_sites_updated_at"();

CREATE OR REPLACE FUNCTION "public"."reap_expired_browser_sites"()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expired RECORD;
  latest_run RECORD;
  reaped integer := 0;
BEGIN
  FOR expired IN
    SELECT workspace_id, host
    FROM workspace_browser_sites
    WHERE expires_at < now()
  LOOP
    SELECT id, account_id INTO latest_run
    FROM cloud_runs
    WHERE workspace_id = expired.workspace_id
      AND status IN ('running','pending','awaiting_approval')
    ORDER BY created_at DESC
    LIMIT 1;

    IF latest_run.id IS NOT NULL THEN
      INSERT INTO cloud_activity (agent_run_id, workspace_id, account_id, activity_type, payload)
      VALUES (
        latest_run.id,
        expired.workspace_id,
        latest_run.account_id,
        'browser_session_expired',
        jsonb_build_object('host', expired.host, 'reason', 'auto_reaper')
      );
    END IF;

    reaped := reaped + 1;
  END LOOP;

  DELETE FROM workspace_browser_sites WHERE expires_at < now();
  RETURN reaped;
END;
$$;

REVOKE ALL ON FUNCTION "public"."reap_expired_browser_sites"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."reap_expired_browser_sites"() TO service_role;

-- pg_cron job: daily at 03:30 UTC.
SELECT cron.unschedule('reap-expired-browser-sites')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='reap-expired-browser-sites');

SELECT cron.schedule(
  'reap-expired-browser-sites',
  '30 3 * * *',
  $$ SELECT public.reap_expired_browser_sites(); $$
);

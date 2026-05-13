-- A.3 — automations: per-workspace output quotas for SMS / email / artifacts.
-- Applied to production via Supabase MCP migration `automations_a3_output_quotas`
-- on 2026-05-13; mirrored here so the Drizzle history stays the canonical record.
-- All statements use IF NOT EXISTS / OR REPLACE so re-applying is a no-op.

CREATE TABLE IF NOT EXISTS "workspace_output_quotas" (
  "workspace_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "count_today" integer DEFAULT 0 NOT NULL,
  "reset_at" timestamp with time zone DEFAULT (now() + interval '1 day') NOT NULL,
  CONSTRAINT "workspace_output_quotas_pkey" PRIMARY KEY ("workspace_id", "channel"),
  CONSTRAINT "workspace_output_quotas_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade
);

ALTER TABLE "workspace_output_quotas" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_output_quotas_select_workspace_member"
  ON "workspace_output_quotas";

CREATE POLICY "workspace_output_quotas_select_workspace_member"
  ON "workspace_output_quotas"
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

CREATE OR REPLACE FUNCTION "public"."increment_output_quota"(
  p_workspace_id uuid,
  p_channel text,
  p_cap integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_reset timestamptz;
BEGIN
  INSERT INTO workspace_output_quotas (workspace_id, channel, count_today, reset_at)
  VALUES (p_workspace_id, p_channel, 0, now() + interval '1 day')
  ON CONFLICT (workspace_id, channel) DO NOTHING;

  SELECT count_today, reset_at INTO v_count, v_reset
  FROM workspace_output_quotas
  WHERE workspace_id = p_workspace_id AND channel = p_channel
  FOR UPDATE;

  IF now() >= v_reset THEN
    UPDATE workspace_output_quotas
    SET count_today = 0, reset_at = now() + interval '1 day'
    WHERE workspace_id = p_workspace_id AND channel = p_channel
    RETURNING count_today, reset_at INTO v_count, v_reset;
  END IF;

  IF v_count >= p_cap THEN
    RETURN false;
  END IF;

  UPDATE workspace_output_quotas
  SET count_today = count_today + 1
  WHERE workspace_id = p_workspace_id AND channel = p_channel;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION "public"."increment_output_quota"(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."increment_output_quota"(uuid, text, integer) TO service_role;

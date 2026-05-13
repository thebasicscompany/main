-- C.1 — Approvals gate tables.
-- Applied to production via Supabase MCP migration
-- `automations_c1_approvals_tables` on 2026-05-13; mirrored here so the
-- Drizzle history stays the canonical record.

CREATE TABLE IF NOT EXISTS "approvals" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id"             uuid NOT NULL,
  "workspace_id"       uuid NOT NULL,
  "tool_name"          text NOT NULL,
  "tool_call_id"       text NOT NULL,
  "args_preview"       jsonb NOT NULL,
  "args_hash"          text NOT NULL,
  "reason"             text NOT NULL,
  "status"             text NOT NULL,
  "decided_by"         uuid,
  "decided_at"         timestamp with time zone,
  "expires_at"         timestamp with time zone NOT NULL,
  "access_token_hash"  text NOT NULL,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approvals_status_check"
    CHECK ("status" IN ('pending','approved','denied','expired')),
  CONSTRAINT "approvals_run_id_cloud_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."cloud_runs"("id") ON DELETE cascade,
  CONSTRAINT "approvals_decided_by_accounts_id_fk"
    FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id")
);

CREATE INDEX IF NOT EXISTS "approvals_run_status_idx"
  ON "approvals" ("run_id", "status");
CREATE INDEX IF NOT EXISTS "approvals_expires_idx"
  ON "approvals" ("expires_at") WHERE status='pending';

CREATE TABLE IF NOT EXISTS "approval_rules" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"       uuid NOT NULL,
  "tool_name"          text NOT NULL,
  "args_pattern_json"  jsonb NOT NULL,
  "created_by"         uuid NOT NULL,
  "expires_at"         timestamp with time zone DEFAULT (now() + interval '30 days') NOT NULL,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_rules_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  CONSTRAINT "approval_rules_created_by_accounts_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id")
);

CREATE INDEX IF NOT EXISTS "approval_rules_workspace_tool_idx"
  ON "approval_rules" ("workspace_id", "tool_name");

ALTER TABLE "approvals"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_rules" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "approvals_select_workspace_member" ON "approvals";
CREATE POLICY "approvals_select_workspace_member"
  ON "approvals" FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      JOIN accounts a ON a.id = wm.account_id
      WHERE a.supabase_auth_id = ((SELECT auth.uid()))::text
        AND wm.seat_status = 'active'
    )
  );

DROP POLICY IF EXISTS "approval_rules_select_workspace_member" ON "approval_rules";
CREATE POLICY "approval_rules_select_workspace_member"
  ON "approval_rules" FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      JOIN accounts a ON a.id = wm.account_id
      WHERE a.supabase_auth_id = ((SELECT auth.uid()))::text
        AND wm.seat_status = 'active'
    )
  );

-- Trigger: emit approval_expired activity event when status flips pending→expired.
CREATE OR REPLACE FUNCTION "public"."tg_approval_expired_event"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF NEW.status = 'expired' AND OLD.status = 'pending' THEN
    SELECT account_id INTO v_account_id FROM public.cloud_runs WHERE id = NEW.run_id;
    INSERT INTO public.cloud_activity (agent_run_id, workspace_id, account_id, activity_type, payload)
    VALUES (
      NEW.run_id,
      NEW.workspace_id,
      v_account_id,
      'approval_expired',
      jsonb_build_object(
        'kind', 'approval_expired',
        'approval_id', NEW.id,
        'tool_name', NEW.tool_name,
        'tool_call_id', NEW.tool_call_id,
        'expires_at', NEW.expires_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "approvals_emit_expired_event" ON "approvals";
CREATE TRIGGER "approvals_emit_expired_event"
  AFTER UPDATE OF status ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION "public"."tg_approval_expired_event"();

-- pg_cron job — flips pending→expired every minute.
DO $$
BEGIN
  PERFORM cron.unschedule('reap-expired-approvals');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'reap-expired-approvals',
  '* * * * *',
  $$ UPDATE public.approvals
        SET status='expired'
      WHERE status='pending' AND now() >= expires_at $$
);

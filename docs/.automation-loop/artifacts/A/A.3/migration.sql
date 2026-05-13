-- automations_a3_output_quotas (applied via mcp__supabase__apply_migration)
-- Project: Basics (xihupmgkamnfbzacksja)
-- Applied at: 2026-05-13

CREATE TABLE IF NOT EXISTS public.workspace_output_quotas (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL,
  count_today integer NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL DEFAULT (now() + interval '1 day'),
  PRIMARY KEY (workspace_id, channel)
);

ALTER TABLE public.workspace_output_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_output_quotas_select_workspace_member
  ON public.workspace_output_quotas
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

CREATE OR REPLACE FUNCTION public.increment_output_quota(
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

REVOKE ALL ON FUNCTION public.increment_output_quota(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_output_quota(uuid, text, integer) TO service_role;

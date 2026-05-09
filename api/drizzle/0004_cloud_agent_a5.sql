-- BUILD-LOOP A.5 — cloud-agent foundations.
-- Applied via Supabase MCP apply_migration on 2026-05-08 against project
-- xihupmgkamnfbzacksja (Basics). Mirrored here for drizzle's record.
--
-- Additive-only: 4 new tables + 1 column + pg_cron extension + 1 cron job +
-- 1 publication add. Reuses existing tables (agent_runs, agent_run_steps,
-- pending_approvals, agent_activity, skills) per CLOUD-AGENT-PLAN §13
-- reconciliation table.

-- 1. agent_helpers — per-workspace helper modules (mirror of EFS helpers/).
CREATE TABLE IF NOT EXISTS public.agent_helpers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  last_modified_at TIMESTAMPTZ NOT NULL,
  last_imported_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
ALTER TABLE public.agent_helpers ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_helpers_workspace_read ON public.agent_helpers
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE account_id = auth.uid()));

-- 2. agent_lanes — multi-agent lanes (e.g. 'ops', 'research') per workspace.
CREATE TABLE IF NOT EXISTS public.agent_lanes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  default_workflow_id UUID,
  default_model TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
ALTER TABLE public.agent_lanes ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_lanes_workspace_read ON public.agent_lanes
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE account_id = auth.uid()));

-- 3. agent_inboxes — inter-agent messaging (intra-workspace; cross-workspace
--    grants are §0.2 out of scope for now).
CREATE TABLE IF NOT EXISTS public.agent_inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  to_lane_id UUID REFERENCES public.agent_lanes(id) ON DELETE SET NULL,
  from_workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  from_lane_id UUID REFERENCES public.agent_lanes(id) ON DELETE SET NULL,
  body JSONB NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_inboxes_to_workspace_lane_read_idx
  ON public.agent_inboxes (to_workspace_id, to_lane_id, read_at);
ALTER TABLE public.agent_inboxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_inboxes_workspace_read ON public.agent_inboxes
  FOR SELECT TO authenticated
  USING (
    to_workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE account_id = auth.uid())
    OR from_workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE account_id = auth.uid())
  );

-- 4. workspace_active_tasks — ECS task tracker. Single row per active workspace
--    task (one task per workspace). Reaper job below clears stale rows.
CREATE TABLE IF NOT EXISTS public.workspace_active_tasks (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  task_arn TEXT NOT NULL,
  cluster TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','active','stopping','dead'))
);
CREATE INDEX IF NOT EXISTS workspace_active_tasks_last_activity_idx
  ON public.workspace_active_tasks (last_activity_at);
CREATE INDEX IF NOT EXISTS workspace_active_tasks_expires_at_idx
  ON public.workspace_active_tasks (expires_at);
ALTER TABLE public.workspace_active_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_active_tasks_workspace_read ON public.workspace_active_tasks
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE account_id = auth.uid()));

-- 5. workspaces.agent_settings — per-workspace agent config (timezone,
--    preferredProvider, dailyCostCeilingCents, approvalPolicy, etc.). Plan §13.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS agent_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 6. pg_cron extension + reaper job. Workers update last_activity_at on every
--    SQS poll; thresholds intentionally 2× the worker's 5-min idle self-stop
--    so a momentary heartbeat lapse doesn't cause a duplicate RunTask.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $reaper$
BEGIN
  -- Drop existing schedule by name if present (idempotent re-run).
  PERFORM cron.unschedule('reap-workspace-active-tasks')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reap-workspace-active-tasks');
EXCEPTION WHEN undefined_function THEN
  NULL;
END
$reaper$;

SELECT cron.schedule(
  'reap-workspace-active-tasks',
  '* * * * *',
  $$
    DELETE FROM public.workspace_active_tasks
     WHERE (status = 'starting' AND last_activity_at < now() - interval '5 minutes')
        OR (status = 'active'   AND last_activity_at < now() - interval '10 minutes')
        OR (status = 'stopping' AND last_activity_at < now() - interval '2 minutes')
        OR  expires_at < now()
  $$
);

-- 7. Add agent_activity to the supabase_realtime publication so INSERTs
--    from the worker broadcast to SSE clients via Postgres logical replication.
--    DO block guards against the table already being a publication member.
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agent_activity'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_activity';
  END IF;
END
$pub$;

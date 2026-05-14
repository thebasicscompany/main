-- K.1 — agent-authored helpers (token-decay architecture).
-- Mirrors the Supabase MCP migration of the same name. Distinct from
-- the legacy `cloud_helpers` table (file tracking) — this one stores
-- TypeScript modules the agent writes during dry-run / successful runs
-- and that the worker registers as opencode tools or invokes directly
-- via the dispatcher fast-path (K.7).

ALTER TABLE public.cloud_skills
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'doc'
  CHECK (kind IN ('doc','playbook','helper_ref'));

CREATE TABLE IF NOT EXISTS public.cloud_agent_helpers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  automation_id uuid NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  args_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  body text NOT NULL,
  helper_version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  superseded_by uuid NULL REFERENCES public.cloud_agent_helpers(id) ON DELETE SET NULL,
  source_run_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_helpers_ws_name_version
  ON public.cloud_agent_helpers (workspace_id, name, helper_version);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_helpers_active_lookup
  ON public.cloud_agent_helpers (workspace_id, name)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_helpers_automation
  ON public.cloud_agent_helpers (workspace_id, automation_id)
  WHERE automation_id IS NOT NULL AND active = true;

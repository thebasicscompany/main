-- BUILD-LOOP H.2 — opencode multi-tenant pool. Per-session bindings.
-- Applied via Supabase MCP apply_migration on 2026-05-09 against project
-- xihupmgkamnfbzacksja (Basics). Mirrored here for drizzle's record.
--
-- H.3 extends with `opencode_pools(...)` once the pool host pattern lands.
-- H.2 only needs the binding so the plugin can resolve sessionID →
-- workspaceId/runId/accountId without process env (the singleton-trap fix).

CREATE TABLE IF NOT EXISTS public.opencode_session_bindings (
  session_id TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  pool_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opencode_session_bindings_workspace_idx
  ON public.opencode_session_bindings (workspace_id);

CREATE INDEX IF NOT EXISTS opencode_session_bindings_pool_idx
  ON public.opencode_session_bindings (pool_id) WHERE pool_id IS NOT NULL;

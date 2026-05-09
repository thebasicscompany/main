-- BUILD-LOOP H.3 — opencode pool registry.
-- Applied via Supabase MCP apply_migration on 2026-05-09.

CREATE TABLE IF NOT EXISTS public.opencode_pools (
  pool_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_arn TEXT NOT NULL,
  cluster TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 4096,
  slots_used INTEGER NOT NULL DEFAULT 0,
  slots_max INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting','active','draining','dead')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '4 hours')
);

CREATE INDEX IF NOT EXISTS opencode_pools_status_capacity_idx
  ON public.opencode_pools (status, slots_used) WHERE status = 'active';

ALTER TABLE public.opencode_session_bindings
  DROP CONSTRAINT IF EXISTS opencode_session_bindings_pool_id_fkey;

ALTER TABLE public.opencode_session_bindings
  ADD CONSTRAINT opencode_session_bindings_pool_id_fkey
  FOREIGN KEY (pool_id) REFERENCES public.opencode_pools(pool_id) ON DELETE SET NULL;

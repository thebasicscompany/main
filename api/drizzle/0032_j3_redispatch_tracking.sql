-- J.3 — orphan-run redispatch.
-- Mirrors the Supabase MCP migration of the same name. The autoscaler's
-- sweepOrphanBindings is extended to redispatch stuck runs (status=running
-- but no recent progress) to a fresh pool, capped at 2 retries; on the
-- 3rd attempt the run is marked status='failed_orphaned'.

ALTER TABLE public.cloud_runs
  ADD COLUMN IF NOT EXISTS redispatch_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;

UPDATE public.cloud_runs
   SET last_progress_at = COALESCE(started_at, created_at)
 WHERE last_progress_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_runs_orphan_sweep
  ON public.cloud_runs (status, last_progress_at)
  WHERE status IN ('running','pending');

COMMENT ON COLUMN public.cloud_runs.redispatch_attempts IS
  'J.3 — number of times the orphan-sweep re-enqueued this run after detecting a stuck/dead pool. Capped at 2; 3rd attempt marks status=failed_orphaned.';
COMMENT ON COLUMN public.cloud_runs.last_progress_at IS
  'J.3 — bumped by the worker on every opencode SSE event for this run, used by the orphan sweep to detect stuck runs.';

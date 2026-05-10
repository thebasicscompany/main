-- PR 1 (cancel + slot hygiene). Adds `ended_at` to cloud_session_bindings so
-- the pool host can reconcile slots_used authoritatively from a single SQL
-- query (UPDATE cloud_pools SET slots_used = count(*) WHERE ended_at IS NULL),
-- instead of trusting incremental decrement-on-terminal-event which leaks
-- whenever opencode-serve crashes mid-session.
--
-- Backfill: any pre-existing binding row whose pool is no longer active is
-- marked ended_at = now() so the new active-binding count starts from a clean
-- slate. Future terminal handlers in worker/src/main.ts write ended_at = now()
-- when session.idle / session.error / session.deleted fires.

ALTER TABLE public.cloud_session_bindings
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;

-- Partial index supports the "count active bindings for pool" reconciliation
-- query in worker/src/main.ts:reconcileSlots without a full table scan.
CREATE INDEX IF NOT EXISTS cloud_session_bindings_active_pool_idx
  ON public.cloud_session_bindings (pool_id)
 WHERE pool_id IS NOT NULL AND ended_at IS NULL;

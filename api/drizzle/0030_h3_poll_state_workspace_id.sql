-- H.3 — Denormalize workspace_id onto composio_poll_state so the
-- workspace-fair sweep doesn't have to JOIN automations on every
-- 1-min tick. Two cheap consequences: (1) the ROW_NUMBER() OVER
-- (PARTITION BY workspace_id) window uses a single-table scan,
-- and (2) the partition index below lets Postgres avoid a sort
-- inside each partition.

ALTER TABLE public.composio_poll_state
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Backfill from automations.workspace_id (safe re-run via WHERE).
UPDATE public.composio_poll_state cps
   SET workspace_id = a.workspace_id
  FROM public.automations a
 WHERE a.id = cps.automation_id
   AND cps.workspace_id IS NULL;

ALTER TABLE public.composio_poll_state
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE public.composio_poll_state
  DROP CONSTRAINT IF EXISTS composio_poll_state_workspace_id_workspaces_id_fk;

ALTER TABLE public.composio_poll_state
  ADD CONSTRAINT composio_poll_state_workspace_id_workspaces_id_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- Partition-aware index for the H.3 fairness sweep. Matches the
-- existing partial-index pattern (paused_at IS NULL hot path).
CREATE INDEX IF NOT EXISTS composio_poll_state_workspace_due_idx
  ON public.composio_poll_state (workspace_id, next_poll_at)
  WHERE paused_at IS NULL;

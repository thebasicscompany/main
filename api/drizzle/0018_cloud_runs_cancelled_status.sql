-- PR 1 follow-up — extend the cloud_runs.status CHECK constraint to
-- include 'cancelled'. Without this, both the api cancel route and the
-- worker terminal handler hit a constraint violation when writing the
-- new status.
--
-- The constraint is still named agent_runs_status_check (legacy name
-- carried through the 0012 rename); we keep that name for continuity
-- rather than renaming the constraint at the same time as expanding it.

ALTER TABLE public.cloud_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check;

ALTER TABLE public.cloud_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status = ANY (ARRAY[
    'queued',
    'pending',
    'running',
    'paused_for_approval',
    'paused_by_user',
    'completed',
    'failed',
    'skipped',
    'killed',
    'cancelled'
  ]));

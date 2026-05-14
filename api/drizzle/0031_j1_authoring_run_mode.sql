-- Phase J.1 — opencode-driven authoring chat.
--
-- The authoring chat run is a long-lived cloud_run on the worker pool: the
-- agent (Opus 4.7) iterates with the user, calling Composio + browser tools
-- + propose_automation/activate_automation. Between turns the run sits in
-- 'awaiting_user' status while the opencode session is idle but kept alive.
--
-- Both CHECK constraints are widened additively; existing rows are unaffected.

ALTER TABLE public.cloud_runs DROP CONSTRAINT agent_runs_run_mode_check;
ALTER TABLE public.cloud_runs
  ADD CONSTRAINT agent_runs_run_mode_check
  CHECK (run_mode = ANY (ARRAY['live'::text, 'test'::text, 'authoring'::text]));

ALTER TABLE public.cloud_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE public.cloud_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status = ANY (ARRAY[
    'queued'::text, 'pending'::text, 'running'::text,
    'paused_for_approval'::text, 'paused_by_user'::text,
    'awaiting_user'::text,
    'completed'::text, 'failed'::text, 'skipped'::text,
    'killed'::text, 'cancelled'::text
  ]));

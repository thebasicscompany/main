-- Phase H follow-up — rename cloud-agent-related tables to a consistent
-- `cloud_` prefix. Drop the legacy workspace_active_tasks (superseded by
-- cloud_pools in H.3). Update supabase_realtime publication.
--
-- Applied via Supabase MCP on 2026-05-09. Mirrored here for drizzle's record.

DROP TABLE IF EXISTS public.workspace_active_tasks CASCADE;

ALTER TABLE public.agent_runs        RENAME TO cloud_runs;
ALTER TABLE public.agent_activity    RENAME TO cloud_activity;
ALTER TABLE public.agent_run_steps   RENAME TO cloud_run_steps;
ALTER TABLE public.agent_helpers     RENAME TO cloud_helpers;
ALTER TABLE public.agent_lanes       RENAME TO cloud_lanes;
ALTER TABLE public.agent_inboxes     RENAME TO cloud_inboxes;
ALTER TABLE public.skills            RENAME TO cloud_skills;
ALTER TABLE public.opencode_pools    RENAME TO cloud_pools;
ALTER TABLE public.opencode_session_bindings RENAME TO cloud_session_bindings;

ALTER PUBLICATION supabase_realtime DROP TABLE public.cloud_activity;
ALTER PUBLICATION supabase_realtime ADD TABLE public.cloud_activity;

ALTER TABLE runtime.runtime_conversations RENAME TO cloud_conversations;
ALTER TABLE runtime.runtime_messages      RENAME TO cloud_messages;

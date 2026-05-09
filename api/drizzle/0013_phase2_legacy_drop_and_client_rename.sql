-- Phase 2 cleanup — drop the legacy v1 in-process orchestrator tables
-- (Phase 01–09 path), the Phase 10.5 workflow surface, and the routine-imports
-- bridge that was never used in production. Rename the desktop-chat tables in
-- the runtime schema to client_* so the prefix matches their consumer (the
-- desktop client) rather than the cloud-agent core (which lives in `public`).
--
-- Q&A confirmation:
--   Q1 /v1/runtime/runs   — no traffic                → drop tables, delete code
--   Q2 /v1/runtime/workflows — 6 prod rows are tests  → drop, delete code
--   Q3 v1 approvals       — keep idea, drop impl       → drop tables, delete code
--   Q4 routine-imports    — never used in prod         → drop, delete code
--   Q5 desktop chat       → client_*                   → rename here
--   Q6 runtime_tool_calls — 76 MB of test-run blobs    → drop (v2 logs to cloud_activity)
--
-- Applied via Supabase MCP on 2026-05-09. Mirrored here for drizzle's record.

-- v1 in-process orchestrator (replaced by public.cloud_runs + cloud_activity).
DROP TABLE IF EXISTS runtime.runtime_tool_calls    CASCADE;
DROP TABLE IF EXISTS runtime.runtime_run_steps     CASCADE;
DROP TABLE IF EXISTS runtime.runtime_check_results CASCADE;
DROP TABLE IF EXISTS runtime.runtime_approvals     CASCADE;
DROP TABLE IF EXISTS runtime.runtime_runs          CASCADE;

-- Phase 04B trust grants — only meaningful with v1's pause-and-resume gate.
DROP TABLE IF EXISTS runtime.runtime_trust_grants CASCADE;

-- Phase 10.5 workflows (replaced by public.cloud_agents + cloud_schedules).
DROP TABLE IF EXISTS runtime.runtime_workflow_versions CASCADE;
DROP TABLE IF EXISTS runtime.runtime_workflows         CASCADE;

-- Phase 10 M1 routine-import bridge (never wired to a real client).
DROP TABLE IF EXISTS runtime.runtime_routine_artifacts CASCADE;
DROP TABLE IF EXISTS runtime.runtime_routine_imports   CASCADE;

-- Phase-13 rollup view from migration 0006_usage_rollup_views.sql. The code
-- (worker/src/cost-tracker.ts) was already rewired to use usage_tracking;
-- the view itself was never dropped. Cleaning up now.
DROP VIEW IF EXISTS runtime.run_cost_lines CASCADE;

-- Desktop-chat rename — these tables back the /v1/assistants surface (the
-- desktop client's chat with its assistant), not the cloud-agent runtime.
-- Idempotent because this cleanup was first applied manually via Supabase MCP.
DO $$
BEGIN
  IF to_regclass('runtime.client_conversations') IS NULL
     AND to_regclass('runtime.cloud_conversations') IS NOT NULL THEN
    ALTER TABLE runtime.cloud_conversations RENAME TO client_conversations;
  END IF;

  IF to_regclass('runtime.client_messages') IS NULL
     AND to_regclass('runtime.cloud_messages') IS NOT NULL THEN
    ALTER TABLE runtime.cloud_messages RENAME TO client_messages;
  END IF;

  IF to_regclass('runtime.client_assistants') IS NULL
     AND to_regclass('runtime.desktop_assistants') IS NOT NULL THEN
    ALTER TABLE runtime.desktop_assistants RENAME TO client_assistants;
  END IF;
END $$;

-- Index renames so the names track the table prefix.
ALTER INDEX IF EXISTS runtime.runtime_conversations_ws_acct_asst_client_key   RENAME TO client_conversations_ws_acct_asst_client_key;
ALTER INDEX IF EXISTS runtime.runtime_conversations_ws_asst_last_message_idx  RENAME TO client_conversations_ws_asst_last_message_idx;
ALTER INDEX IF EXISTS runtime.runtime_conversations_ws_asst_archived_idx      RENAME TO client_conversations_ws_asst_archived_idx;
ALTER INDEX IF EXISTS runtime.runtime_messages_conversation_created_idx       RENAME TO client_messages_conversation_created_idx;
ALTER INDEX IF EXISTS runtime.runtime_messages_ws_asst_conversation_idx       RENAME TO client_messages_ws_asst_conversation_idx;
ALTER INDEX IF EXISTS runtime.runtime_messages_conversation_client_message_key RENAME TO client_messages_conversation_client_message_key;
ALTER INDEX IF EXISTS runtime.desktop_assistants_ws_install_runtime_key       RENAME TO client_assistants_ws_install_runtime_key;
ALTER INDEX IF EXISTS runtime.desktop_assistants_workspace_status_idx         RENAME TO client_assistants_workspace_status_idx;
ALTER INDEX IF EXISTS runtime.desktop_assistants_workspace_active_idx         RENAME TO client_assistants_workspace_active_idx;

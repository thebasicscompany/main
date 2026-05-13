-- Per-automation approval_rules scoping.
-- Applied to production via Supabase MCP migration
-- `approval_rules_automation_scoping` on 2026-05-13.
--
-- Adds a nullable automation_id column so an approval rule can be scoped
-- to a specific automation (e.g., "auto-approve send_sms to +19722144223
-- from THIS automation only"). NULL automation_id keeps the original
-- workspace-wide semantics for ad-hoc agent flows.
--
-- The C.3 lookupApprovalRule helper matches the rule when:
--   (rule.automation_id IS NULL OR rule.automation_id = current_run.automation_id)
--   AND rule.workspace_id = workspace_id
--   AND rule.tool_name   = tool_name
--   AND args             @> rule.args_pattern_json
--
-- ON DELETE CASCADE so deleting an automation drops its standing rules.

ALTER TABLE "approval_rules"
  ADD COLUMN IF NOT EXISTS "automation_id" uuid;

ALTER TABLE "approval_rules"
  ADD CONSTRAINT "approval_rules_automation_id_automations_id_fk"
  FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "approval_rules_workspace_tool_auto_idx"
  ON "approval_rules" ("workspace_id", "tool_name", "automation_id");

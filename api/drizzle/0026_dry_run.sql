-- E.6 — Draft / dry-run lifecycle columns.
-- Applied to production via Supabase MCP migration `automations_e6_dry_run`
-- on 2026-05-13; mirrored here so the Drizzle history stays the canonical
-- record. All statements are IF NOT EXISTS / OR REPLACE so re-applying
-- is a no-op.
--
-- (a) automations.status: 'draft' | 'active' | 'archived'. Existing rows
--     get back-filled to 'active' so CRUD behavior is unchanged. The
--     archived_at soft-delete column stays; we also set status='archived'
--     alongside it on DELETE (route layer in E.8).
--
-- (b) cloud_runs.dry_run + dry_run_actions. The interceptor (E.7) buffers
--     mutating outbound tool calls into dry_run_actions instead of letting
--     them dispatch. The triggered_by CHECK is widened to include the
--     'dry_run' source so the E.8 endpoint can dispatch dry runs without
--     pretending to be a manual / webhook / schedule trigger.

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';

UPDATE "automations" SET "status" = 'active' WHERE "status" IS NULL;

ALTER TABLE "automations"
  DROP CONSTRAINT IF EXISTS "automations_status_check";
ALTER TABLE "automations"
  ADD CONSTRAINT "automations_status_check"
    CHECK ("status" IN ('draft', 'active', 'archived'));

CREATE INDEX IF NOT EXISTS "automations_drafts_idx"
  ON "automations" ("workspace_id", "created_at" DESC)
  WHERE "status" = 'draft';

ALTER TABLE "cloud_runs"
  ADD COLUMN IF NOT EXISTS "dry_run" boolean NOT NULL DEFAULT false;

ALTER TABLE "cloud_runs"
  ADD COLUMN IF NOT EXISTS "dry_run_actions" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "cloud_runs"
  DROP CONSTRAINT IF EXISTS "cloud_runs_triggered_by_check";
ALTER TABLE "cloud_runs"
  ADD CONSTRAINT "cloud_runs_triggered_by_check"
    CHECK (
      "triggered_by" IS NULL
      OR "triggered_by" IN ('manual', 'schedule', 'composio_webhook', 'dry_run')
    );

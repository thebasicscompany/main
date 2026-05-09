-- Basics Cloud M3: materialized rollups over runtime.usage_events.
-- Refresh: REFRESH MATERIALIZED VIEW CONCURRENTLY runtime.workspace_daily_cost;
--         REFRESH MATERIALIZED VIEW CONCURRENTLY runtime.workspace_monthly_cost;
-- (requires unique indexes below; schedule via EventBridge in deploy checklist.)

CREATE MATERIALIZED VIEW "runtime"."workspace_daily_cost" AS
SELECT
  workspace_id,
  (DATE_TRUNC('day', occurred_at AT TIME ZONE 'UTC'))::date AS day,
  SUM(CASE WHEN kind LIKE 'llm_%' THEN cents ELSE 0 END) AS llm_cents,
  SUM(CASE WHEN kind = 'browser_minutes' THEN cents ELSE 0 END) AS browser_cents,
  SUM(CASE WHEN kind = 'compute_seconds' THEN cents ELSE 0 END) AS compute_cents,
  SUM(cents) AS total_cents
FROM "runtime"."usage_events"
WHERE cents IS NOT NULL
GROUP BY workspace_id, (DATE_TRUNC('day', occurred_at AT TIME ZONE 'UTC'))::date;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_daily_cost_workspace_day_key"
  ON "runtime"."workspace_daily_cost" ("workspace_id", "day");
--> statement-breakpoint
CREATE MATERIALIZED VIEW "runtime"."workspace_monthly_cost" AS
SELECT
  workspace_id,
  (DATE_TRUNC('month', occurred_at AT TIME ZONE 'UTC'))::date AS month,
  SUM(CASE WHEN kind LIKE 'llm_%' THEN cents ELSE 0 END) AS llm_cents,
  SUM(CASE WHEN kind = 'browser_minutes' THEN cents ELSE 0 END) AS browser_cents,
  SUM(CASE WHEN kind = 'compute_seconds' THEN cents ELSE 0 END) AS compute_cents,
  SUM(cents) AS total_cents
FROM "runtime"."usage_events"
WHERE cents IS NOT NULL
GROUP BY workspace_id, (DATE_TRUNC('month', occurred_at AT TIME ZONE 'UTC'))::date;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_monthly_cost_workspace_month_key"
  ON "runtime"."workspace_monthly_cost" ("workspace_id", "month");
--> statement-breakpoint
CREATE VIEW "runtime"."run_cost_lines" AS
SELECT
  id,
  workspace_id,
  run_id,
  kind,
  provider,
  model,
  quantity AS units,
  cents,
  occurred_at AS at
FROM "runtime"."usage_events"
WHERE run_id IS NOT NULL AND cents IS NOT NULL;

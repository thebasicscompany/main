-- Phase 11: lift `runtime_workflows.check_modules` from `text[]` (names only)
-- to `jsonb` ({ name, params }[]).
--
-- Drizzle's auto-generated migration just does ALTER COLUMN with no
-- backfill, which loses the existing names on rows seeded in Phase 11.
-- This rewrite is hand-edited to:
--   1. Add a new `check_modules_v2 jsonb` column with default '[]'::jsonb.
--   2. Backfill from the existing `text[]` for non-empty arrays. NULL /
--      empty rows fall through to the column default.
--   3. Drop the old `check_modules` column.
--   4. Rename `check_modules_v2` → `check_modules`.
--
-- Idempotent across partial-apply scenarios: each statement guards on
-- column existence so re-running against a database that already has
-- the v2 column (or the rename) is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules_v2'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules'
      AND data_type = 'ARRAY'
  ) THEN
    EXECUTE 'ALTER TABLE "runtime"."runtime_workflows" ADD COLUMN "check_modules_v2" jsonb NOT NULL DEFAULT ''[]''::jsonb';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules_v2'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules'
      AND data_type = 'ARRAY'
  ) THEN
    UPDATE "runtime"."runtime_workflows"
       SET "check_modules_v2" = COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('name', n, 'params', '{}'::jsonb))
            FROM unnest("check_modules") AS n),
         '[]'::jsonb
       )
     WHERE "check_modules" IS NOT NULL
       AND array_length("check_modules", 1) IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules'
      AND data_type = 'ARRAY'
  ) THEN
    EXECUTE 'ALTER TABLE "runtime"."runtime_workflows" DROP COLUMN "check_modules"';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules_v2'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'runtime_workflows'
      AND column_name = 'check_modules'
  ) THEN
    EXECUTE 'ALTER TABLE "runtime"."runtime_workflows" RENAME COLUMN "check_modules_v2" TO "check_modules"';
  END IF;
END $$;

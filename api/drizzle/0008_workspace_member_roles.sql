ALTER TABLE "public"."workspace_members" DROP CONSTRAINT IF EXISTS "workspace_members_role_check";
--> statement-breakpoint
ALTER TABLE "public"."workspace_members"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "public"."workspace_members"
  ADD CONSTRAINT "workspace_members_role_check"
    CHECK (role IN ('owner', 'admin', 'member'));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspaces'
      AND column_name = 'created_by'
  ) THEN
    UPDATE "public"."workspace_members" wm
       SET role = 'owner'
      FROM "public"."workspaces" w
     WHERE w.id = wm.workspace_id
       AND wm.account_id = w.created_by;
  END IF;
END $$;

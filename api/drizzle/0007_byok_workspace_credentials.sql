CREATE TABLE IF NOT EXISTS "public"."workspace_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL DEFAULT '',
	"ciphertext" bytea NOT NULL,
	"kms_key_id" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD COLUMN IF NOT EXISTS "provenance" text;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD COLUMN IF NOT EXISTS "status" text;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD COLUMN IF NOT EXISTS "last_provider_error" text;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD COLUMN IF NOT EXISTS "last_provider_error_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "public"."workspace_credentials"
   SET provenance = COALESCE(provenance, 'customer_byok'),
       status = COALESCE(status, 'active')
 WHERE provenance IS NULL OR status IS NULL;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ALTER COLUMN "provenance" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ALTER COLUMN "status" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ALTER COLUMN "ciphertext" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials" DROP CONSTRAINT IF EXISTS "workspace_credentials_provenance_check";
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials" DROP CONSTRAINT IF EXISTS "workspace_credentials_status_check";
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials" DROP CONSTRAINT IF EXISTS "workspace_credentials_active_has_ciphertext";
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD CONSTRAINT "workspace_credentials_provenance_check"
    CHECK (provenance IN ('basics_managed', 'customer_byok'));
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD CONSTRAINT "workspace_credentials_status_check"
    CHECK (status IN ('active', 'not_provisioned', 'cleared'));
--> statement-breakpoint
ALTER TABLE "public"."workspace_credentials"
  ADD CONSTRAINT "workspace_credentials_active_has_ciphertext"
    CHECK (status <> 'active' OR ciphertext IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_credentials_workspace_active"
  ON "public"."workspace_credentials" USING btree ("workspace_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_credentials_unique_kind_label"
  ON "public"."workspace_credentials" USING btree ("workspace_id","kind","label");

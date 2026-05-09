CREATE TABLE IF NOT EXISTS "public"."workspace_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "secret_hash" text NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_account_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "workspace_api_keys_status_check"
    CHECK ("status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_api_keys_prefix_unique"
  ON "public"."workspace_api_keys" USING btree ("prefix");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_api_keys_workspace_status"
  ON "public"."workspace_api_keys" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_api_keys_workspace_metadata"
  ON "public"."workspace_api_keys" USING gin ("metadata");

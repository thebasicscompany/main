CREATE TABLE IF NOT EXISTS "runtime"."desktop_assistants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "client_installation_id" text NOT NULL,
  "runtime_assistant_id" text NOT NULL,
  "client_platform" text NOT NULL,
  "assistant_version" text,
  "machine_name" text,
  "name" text,
  "description" text,
  "hosting" text DEFAULT 'local' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "assistant_api_key_hash" text NOT NULL,
  "webhook_secret_hash" text,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "desktop_assistants_ws_install_runtime_key"
  ON "runtime"."desktop_assistants" USING btree (
    "workspace_id",
    "client_installation_id",
    "runtime_assistant_id"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "desktop_assistants_workspace_status_idx"
  ON "runtime"."desktop_assistants" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "desktop_assistants_workspace_active_idx"
  ON "runtime"."desktop_assistants" USING btree ("workspace_id", "active");
--> statement-breakpoint
ALTER TABLE "runtime"."desktop_assistants" DROP CONSTRAINT IF EXISTS "desktop_assistants_hosting_check";
--> statement-breakpoint
ALTER TABLE "runtime"."desktop_assistants"
  ADD CONSTRAINT "desktop_assistants_hosting_check"
  CHECK ("hosting" IN ('local', 'managed'));
--> statement-breakpoint
ALTER TABLE "runtime"."desktop_assistants" DROP CONSTRAINT IF EXISTS "desktop_assistants_status_check";
--> statement-breakpoint
ALTER TABLE "runtime"."desktop_assistants"
  ADD CONSTRAINT "desktop_assistants_status_check"
  CHECK ("status" IN ('active', 'retired'));

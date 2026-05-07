CREATE TABLE "runtime"."runtime_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" text,
	"required_credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check_modules" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runtime_workflows_workspace_id_enabled_idx" ON "runtime"."runtime_workflows" USING btree ("workspace_id","enabled");
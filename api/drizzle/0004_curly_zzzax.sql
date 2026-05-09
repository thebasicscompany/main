CREATE TABLE "runtime"."runtime_routine_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"workflow_id" uuid,
	"kind" text NOT NULL,
	"storage_url" text,
	"inline_json" jsonb,
	"content_type" text,
	"size_bytes" integer,
	"retention_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_routine_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assistant_routine_id" text NOT NULL,
	"source_assistant_id" text,
	"lens_session_id" text,
	"extension_recording_id" text,
	"workflow_id" uuid,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prompt" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_import_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime"."runtime_routine_artifacts" ADD CONSTRAINT "runtime_routine_artifacts_import_id_runtime_routine_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "runtime"."runtime_routine_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime"."runtime_routine_artifacts" ADD CONSTRAINT "runtime_routine_artifacts_workflow_id_runtime_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "runtime"."runtime_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime"."runtime_routine_imports" ADD CONSTRAINT "runtime_routine_imports_workflow_id_runtime_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "runtime"."runtime_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime"."runtime_workflow_versions" ADD CONSTRAINT "runtime_workflow_versions_workflow_id_runtime_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "runtime"."runtime_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime"."runtime_workflow_versions" ADD CONSTRAINT "runtime_workflow_versions_source_import_id_runtime_routine_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "runtime"."runtime_routine_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_artifacts_import_kind_idx" ON "runtime"."runtime_routine_artifacts" USING btree ("import_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_imports_ws_assistant_id_key" ON "runtime"."runtime_routine_imports" USING btree ("workspace_id","assistant_routine_id");--> statement-breakpoint
CREATE INDEX "routine_imports_workspace_status_idx" ON "runtime"."runtime_routine_imports" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_workflow_version_key" ON "runtime"."runtime_workflow_versions" USING btree ("workflow_id","version");
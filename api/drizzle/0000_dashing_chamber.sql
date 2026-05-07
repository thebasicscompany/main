CREATE SCHEMA IF NOT EXISTS "runtime";
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_via" text,
	"remember" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"triggered_by" uuid,
	"browserbase_session_id" text,
	"context_id" text,
	"live_url" text,
	"takeover_active" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"cost_cents" integer,
	"step_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"tool_name" text NOT NULL,
	"params" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"screenshot_s3_key" text,
	"approval_id" uuid,
	"trust_grant_id" uuid,
	"model_latency_ms" integer,
	"browser_latency_ms" integer,
	"cost_cents" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime"."runtime_trust_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"action_pattern" text NOT NULL,
	"params_constraint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime"."runtime_approvals" ADD CONSTRAINT "runtime_approvals_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runtime"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime"."runtime_run_steps" ADD CONSTRAINT "runtime_run_steps_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runtime"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime"."runtime_tool_calls" ADD CONSTRAINT "runtime_tool_calls_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runtime"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_approvals_run_id_status_idx" ON "runtime"."runtime_approvals" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_run_steps_run_id_step_index_key" ON "runtime"."runtime_run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "runtime_trust_grants_workspace_id_action_pattern_idx" ON "runtime"."runtime_trust_grants" USING btree ("workspace_id","action_pattern");
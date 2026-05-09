CREATE TABLE "runtime"."usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"unit" text NOT NULL,
	"cents" numeric(20, 4),
	"provider" text,
	"model" text,
	"run_id" uuid,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_events_ws_kind_time_idx" ON "runtime"."usage_events" USING btree ("workspace_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_run_idx" ON "runtime"."usage_events" USING btree ("run_id");
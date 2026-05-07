CREATE TABLE "runtime"."runtime_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"check_name" text NOT NULL,
	"passed" boolean NOT NULL,
	"evidence" jsonb,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime"."runtime_check_results" ADD CONSTRAINT "runtime_check_results_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runtime"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_check_results_run_id_ran_at_idx" ON "runtime"."runtime_check_results" USING btree ("run_id","ran_at");
CREATE TABLE IF NOT EXISTS "client_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "surface_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "title" text NOT NULL,
  "word_count" integer DEFAULT 0 NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "content_storage" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_documents_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_documents_surface_key"
  ON "client_documents" ("workspace_id", "assistant_id", "surface_id");
CREATE INDEX IF NOT EXISTS "client_documents_conversation_idx"
  ON "client_documents" ("workspace_id", "assistant_id", "conversation_id");

CREATE TABLE IF NOT EXISTS "client_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "app_id" text NOT NULL,
  "conversation_id" text,
  "name" text NOT NULL,
  "description" text,
  "icon" text,
  "preview" text,
  "html" text DEFAULT '' NOT NULL,
  "version" text,
  "content_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_apps_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_apps_app_key"
  ON "client_apps" ("workspace_id", "assistant_id", "app_id");
CREATE INDEX IF NOT EXISTS "client_apps_conversation_idx"
  ON "client_apps" ("workspace_id", "assistant_id", "conversation_id");

CREATE TABLE IF NOT EXISTS "client_routines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "source_kind" text DEFAULT 'manual' NOT NULL,
  "lens_session_id" text,
  "extension_recording_id" text,
  "started_at" timestamp with time zone,
  "stopped_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_routines_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "client_routines_workspace_assistant_idx"
  ON "client_routines" ("workspace_id", "assistant_id", "updated_at");

CREATE TABLE IF NOT EXISTS "client_routine_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "routine_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "local_uri" text,
  "cloud_uri" text,
  "content_type" text,
  "size_bytes" integer,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_routine_artifacts_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade,
  CONSTRAINT "client_routine_artifacts_routine_id_client_routines_id_fk"
    FOREIGN KEY ("routine_id") REFERENCES "public"."client_routines"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "client_routine_artifacts_routine_idx"
  ON "client_routine_artifacts" ("workspace_id", "assistant_id", "routine_id");

CREATE TABLE IF NOT EXISTS "client_routine_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "routine_id" uuid,
  "status" text NOT NULL,
  "title" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_routine_runs_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade,
  CONSTRAINT "client_routine_runs_routine_id_client_routines_id_fk"
    FOREIGN KEY ("routine_id") REFERENCES "public"."client_routines"("id") ON DELETE set null
);

CREATE INDEX IF NOT EXISTS "client_routine_runs_workspace_assistant_idx"
  ON "client_routine_runs" ("workspace_id", "assistant_id", "created_at");

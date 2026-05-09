CREATE TABLE IF NOT EXISTS "client_memory_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "subject" text NOT NULL,
  "statement" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "confidence" double precision,
  "importance" double precision,
  "verification_state" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_memory_items_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "client_memory_items_ws_asst_status_idx"
  ON "client_memory_items" ("workspace_id", "assistant_id", "status");
CREATE INDEX IF NOT EXISTS "client_memory_items_ws_asst_kind_idx"
  ON "client_memory_items" ("workspace_id", "assistant_id", "kind");
CREATE INDEX IF NOT EXISTS "client_memory_items_ws_asst_last_seen_idx"
  ON "client_memory_items" ("workspace_id", "assistant_id", "last_seen_at");

CREATE TABLE IF NOT EXISTS "client_memory_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "memory_item_id" uuid NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_memory_sources_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade,
  CONSTRAINT "client_memory_sources_memory_item_id_client_memory_items_id_fk"
    FOREIGN KEY ("memory_item_id") REFERENCES "public"."client_memory_items"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "client_memory_sources_item_idx"
  ON "client_memory_sources" ("memory_item_id");
CREATE INDEX IF NOT EXISTS "client_memory_sources_ws_asst_idx"
  ON "client_memory_sources" ("workspace_id", "assistant_id");

CREATE TABLE IF NOT EXISTS "client_memory_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "from_memory_item_id" uuid NOT NULL,
  "to_memory_item_id" uuid NOT NULL,
  "relation" text DEFAULT 'related' NOT NULL,
  "weight" double precision,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_memory_edges_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade,
  CONSTRAINT "client_memory_edges_from_memory_item_id_client_memory_items_id_fk"
    FOREIGN KEY ("from_memory_item_id") REFERENCES "public"."client_memory_items"("id") ON DELETE cascade,
  CONSTRAINT "client_memory_edges_to_memory_item_id_client_memory_items_id_fk"
    FOREIGN KEY ("to_memory_item_id") REFERENCES "public"."client_memory_items"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "client_memory_edges_from_idx"
  ON "client_memory_edges" ("from_memory_item_id");
CREATE INDEX IF NOT EXISTS "client_memory_edges_to_idx"
  ON "client_memory_edges" ("to_memory_item_id");
CREATE UNIQUE INDEX IF NOT EXISTS "client_memory_edges_unique_relation"
  ON "client_memory_edges" ("workspace_id", "assistant_id", "from_memory_item_id", "to_memory_item_id", "relation");

CREATE TABLE IF NOT EXISTS "client_memory_concept_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "rendered" text NOT NULL,
  "body_bytes" integer DEFAULT 0 NOT NULL,
  "edge_count" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_memory_concept_pages_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_memory_concept_pages_ws_asst_slug_key"
  ON "client_memory_concept_pages" ("workspace_id", "assistant_id", "slug");
CREATE INDEX IF NOT EXISTS "client_memory_concept_pages_ws_asst_updated_idx"
  ON "client_memory_concept_pages" ("workspace_id", "assistant_id", "updated_at");

CREATE TABLE IF NOT EXISTS "client_memory_embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "owner_type" text NOT NULL,
  "owner_id" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "vector_ref" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_memory_embeddings_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_memory_embeddings_owner_key"
  ON "client_memory_embeddings" ("workspace_id", "assistant_id", "owner_type", "owner_id", "provider", "model");

CREATE TABLE IF NOT EXISTS "client_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid,
  "scope" text NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_settings_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_settings_scope_key"
  ON "client_settings" ("workspace_id", "account_id", "assistant_id", "scope");

CREATE TABLE IF NOT EXISTS "client_assistant_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_assistant_profiles_assistant_id_client_assistants_id_fk"
    FOREIGN KEY ("assistant_id") REFERENCES "public"."client_assistants"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_assistant_profiles_name_key"
  ON "client_assistant_profiles" ("workspace_id", "assistant_id", "name");
CREATE INDEX IF NOT EXISTS "client_assistant_profiles_active_idx"
  ON "client_assistant_profiles" ("workspace_id", "assistant_id", "active");

CREATE TABLE IF NOT EXISTS "runtime"."runtime_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL,
  "client_conversation_key" text NOT NULL,
  "title" text NOT NULL,
  "source" text DEFAULT 'macos' NOT NULL,
  "last_message_at" timestamp with time zone,
  "archived" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_conversations_assistant_id_desktop_assistants_id_fk"
    FOREIGN KEY ("assistant_id")
    REFERENCES "runtime"."desktop_assistants"("id")
    ON DELETE cascade
    ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_conversations_ws_acct_asst_client_key"
  ON "runtime"."runtime_conversations" USING btree
  ("workspace_id", "account_id", "assistant_id", "client_conversation_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_conversations_ws_asst_last_message_idx"
  ON "runtime"."runtime_conversations" USING btree
  ("workspace_id", "assistant_id", "last_message_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_conversations_ws_asst_archived_idx"
  ON "runtime"."runtime_conversations" USING btree
  ("workspace_id", "assistant_id", "archived");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime"."runtime_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "client_message_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_messages_conversation_id_runtime_conversations_id_fk"
    FOREIGN KEY ("conversation_id")
    REFERENCES "runtime"."runtime_conversations"("id")
    ON DELETE cascade
    ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_messages_conversation_created_idx"
  ON "runtime"."runtime_messages" USING btree
  ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_messages_ws_asst_conversation_idx"
  ON "runtime"."runtime_messages" USING btree
  ("workspace_id", "conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_messages_conversation_client_message_key"
  ON "runtime"."runtime_messages" USING btree
  ("conversation_id", "client_message_id");

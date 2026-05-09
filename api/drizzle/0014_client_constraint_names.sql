DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'desktop_assistants_pkey'
      AND conrelid = 'runtime.client_assistants'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_assistants"
      RENAME CONSTRAINT "desktop_assistants_pkey"
      TO "client_assistants_pkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'desktop_assistants_hosting_check'
      AND conrelid = 'runtime.client_assistants'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_assistants"
      RENAME CONSTRAINT "desktop_assistants_hosting_check"
      TO "client_assistants_hosting_check";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'desktop_assistants_status_check'
      AND conrelid = 'runtime.client_assistants'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_assistants"
      RENAME CONSTRAINT "desktop_assistants_status_check"
      TO "client_assistants_status_check";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runtime_conversations_assistant_id_desktop_assistants_id_fk'
      AND conrelid = 'runtime.client_conversations'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_conversations"
      RENAME CONSTRAINT "runtime_conversations_assistant_id_desktop_assistants_id_fk"
      TO "client_conversations_assistant_id_client_assistants_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cloud_conversations_assistant_id_desktop_assistants_id_fk'
      AND conrelid = 'runtime.client_conversations'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_conversations"
      RENAME CONSTRAINT "cloud_conversations_assistant_id_desktop_assistants_id_fk"
      TO "client_conversations_assistant_id_client_assistants_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runtime_conversations_pkey'
      AND conrelid = 'runtime.client_conversations'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_conversations"
      RENAME CONSTRAINT "runtime_conversations_pkey"
      TO "client_conversations_pkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cloud_conversations_pkey'
      AND conrelid = 'runtime.client_conversations'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_conversations"
      RENAME CONSTRAINT "cloud_conversations_pkey"
      TO "client_conversations_pkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runtime_messages_conversation_id_runtime_conversations_id_fk'
      AND conrelid = 'runtime.client_messages'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_messages"
      RENAME CONSTRAINT "runtime_messages_conversation_id_runtime_conversations_id_fk"
      TO "client_messages_conversation_id_client_conversations_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cloud_messages_conversation_id_cloud_conversations_id_fk'
      AND conrelid = 'runtime.client_messages'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_messages"
      RENAME CONSTRAINT "cloud_messages_conversation_id_cloud_conversations_id_fk"
      TO "client_messages_conversation_id_client_conversations_id_fk";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runtime_messages_pkey'
      AND conrelid = 'runtime.client_messages'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_messages"
      RENAME CONSTRAINT "runtime_messages_pkey"
      TO "client_messages_pkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cloud_messages_pkey'
      AND conrelid = 'runtime.client_messages'::regclass
  ) THEN
    ALTER TABLE "runtime"."client_messages"
      RENAME CONSTRAINT "cloud_messages_pkey"
      TO "client_messages_pkey";
  END IF;
END $$;

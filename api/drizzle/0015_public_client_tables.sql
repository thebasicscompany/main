DO $$
BEGIN
  IF to_regclass('public.client_assistants') IS NOT NULL
     AND to_regclass('runtime.client_assistants') IS NOT NULL THEN
    RAISE EXCEPTION 'both public.client_assistants and runtime.client_assistants exist';
  END IF;

  IF to_regclass('public.client_conversations') IS NOT NULL
     AND to_regclass('runtime.client_conversations') IS NOT NULL THEN
    RAISE EXCEPTION 'both public.client_conversations and runtime.client_conversations exist';
  END IF;

  IF to_regclass('public.client_messages') IS NOT NULL
     AND to_regclass('runtime.client_messages') IS NOT NULL THEN
    RAISE EXCEPTION 'both public.client_messages and runtime.client_messages exist';
  END IF;

  IF to_regclass('public.client_assistants') IS NULL
     AND to_regclass('runtime.client_assistants') IS NOT NULL THEN
    ALTER TABLE "runtime"."client_assistants" SET SCHEMA "public";
  END IF;

  IF to_regclass('public.client_conversations') IS NULL
     AND to_regclass('runtime.client_conversations') IS NOT NULL THEN
    ALTER TABLE "runtime"."client_conversations" SET SCHEMA "public";
  END IF;

  IF to_regclass('public.client_messages') IS NULL
     AND to_regclass('runtime.client_messages') IS NOT NULL THEN
    ALTER TABLE "runtime"."client_messages" SET SCHEMA "public";
  END IF;
END $$;

-- G.4 (fix-up) — add public.approvals to the supabase_realtime
-- publication so G.1's workspace-scoped pending-approvals SSE
-- actually receives INSERT/UPDATE/DELETE events. Without this,
-- the route subscribes successfully but never gets postgres_changes
-- payloads. Idempotent via a DO block that checks
-- pg_publication_tables before ALTER PUBLICATION ... ADD TABLE.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'approvals'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.approvals';
  END IF;
END $$;

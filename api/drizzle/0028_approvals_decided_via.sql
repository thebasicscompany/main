-- G.2 — Track WHERE the approval decision came from (desktop UI,
-- SMS reply, signed link, JWT manual call, etc.). Earlier the payload
-- in cloud_activity carried this as `decided_via` derived from auth
-- mode; G.2 promotes it to a first-class column so the desktop's
-- "approve" action can also drive the Sendblue follow-up logic.

ALTER TABLE public.approvals
  ADD COLUMN IF NOT EXISTS decided_via TEXT;

ALTER TABLE public.approvals
  DROP CONSTRAINT IF EXISTS approvals_decided_via_check;

ALTER TABLE public.approvals
  ADD CONSTRAINT approvals_decided_via_check
  CHECK (decided_via IS NULL OR decided_via IN ('desktop','sms','email','manual','signed_token','jwt'));

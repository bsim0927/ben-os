-- Auth baseline: the RLS backstop that sits behind the app-layer gate.
--
-- Per ADR 0001, every module table gets exactly one
--   for all using (is_authorized()) with check (is_authorized())
-- policy. This migration defines the function those policies call. It is
-- deliberately the last thing between a leaked anon key and the data, so it
-- must not depend on any application code being correct.
--
-- There is no public.profile table, and there should not be one: auth relies on
-- auth.users plus the JWT email claim, nothing else.

create or replace function public.is_authorized()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Hardcoded rather than a GUC or env var (ADR 0001): the allowed account
  -- lives in version-controlled SQL so it can only change through a reviewed
  -- migration. Its app-layer twin is ALLOWED_EMAIL in apps/web/lib/auth.ts —
  -- the two are a pair, and both must be edited together.
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'bimmons927@gmail.com';
$$;

comment on function public.is_authorized() is
  'True when the caller''s JWT carries the single authorized account''s email. Called by every module table''s RLS policy (ADR 0001).';

-- Only the roles that actually evaluate RLS need to run it. Granting to anon as
-- well as authenticated matters: without it an unauthenticated query errors on
-- permission instead of cleanly returning nothing. service_role is omitted on
-- purpose — it bypasses RLS, so it never reaches this function.
revoke all on function public.is_authorized() from public;

grant execute on function public.is_authorized() to anon, authenticated;

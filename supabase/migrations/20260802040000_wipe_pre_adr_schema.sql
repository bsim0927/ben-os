-- Wipe the pre-ADR schema.
--
-- The hosted project predates docs/adr/0001. Everything dropped here belongs to
-- the earlier design — a reading-ingester plus a `fin_*` finance prototype —
-- and CLAUDE.md records it as disposable: "nothing currently in `public` is
-- worth preserving". Every one of these tables held 0 rows when this was
-- written, and none follow the `<module>_<entity>` naming the ADRs require, so
-- leaving them would put two generations of the same concept side by side once
-- the `financials_*` tables land.
--
-- `public.is_authorized()` is deliberately NOT dropped. It is the current
-- design's RLS backstop, defined by 20260801000000_auth_baseline.sql, and every
-- module table's policy will call it.
--
-- Every statement is idempotent, so this is safe to apply by any route:
-- `supabase db push`, the dashboard SQL editor, or the Supabase MCP server.

drop view if exists public.v_fin_latest_balances cascade;
drop view if exists public.v_fin_net_worth_history cascade;
drop view if exists public.v_fin_spending_by_category cascade;

drop table if exists public.reading_item_links cascade;
drop table if exists public.reading_link_docs cascade;
drop table if exists public.reading_chunks cascade;
drop table if exists public.reading_digests cascade;
drop table if exists public.reading_items cascade;
drop table if exists public.reading_sources cascade;
drop table if exists public.fin_budgets cascade;
drop table if exists public.fin_transactions cascade;
drop table if exists public.fin_balances cascade;
drop table if exists public.fin_accounts cascade;
drop table if exists public.capture_inbox cascade;
drop table if exists public.tasks cascade;
drop table if exists public.projects cascade;

-- pgvector existed only for the reading corpus' embeddings. Beyond being unused
-- now, living in `public` trips Supabase's `extension_in_public` lint; a future
-- module that needs embeddings should install it into `extensions` instead.
drop extension if exists vector cascade;

-- Reconcile migration history with this repo.
--
-- The six 2026-07-27 versions were applied to the hosted project before this
-- repo existed and have no files here, so `supabase migration list` reports
-- them as remote-only forever. The 2026-08-02 row is a duplicate of
-- 20260801000000_auth_baseline.sql: the same SQL, recorded under a second
-- version because it was applied through the MCP server, which assigns its own
-- timestamp. Dropping both sets leaves history describing exactly the files in
-- supabase/migrations/.
delete from supabase_migrations.schema_migrations
where version in (
  '20260727174036',  -- 0001_core
  '20260727174055',  -- 0002_reading_ingester
  '20260727174107',  -- 0003_reading_corpus
  '20260727174117',  -- 0004_reading_links
  '20260727174129',  -- 0005_finance
  '20260727174156',  -- 0006_finance_views_security_invoker
  '20260802031920'   -- duplicate auth_baseline, applied via MCP
);

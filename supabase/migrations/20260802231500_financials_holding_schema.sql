-- Per-security holdings, and the securities they point at.
--
-- Shapes come from docs/adr/0004-financials-holding-schema.md, on the baseline
-- in docs/adr/0001-baseline-supabase-schema-conventions.md. The financials
-- schema migration deliberately left these out; this is the migration that lands
-- them, beside the SnapTrade sync that fills them.
--
-- Nothing here touches financials_account or financials_connection. ADR 0004
-- decision 7: a SnapTrade-linked account reuses `kind` and `provider_account_id`
-- as they already are, and the connection's `extra` carries the SnapTrade
-- `authorizationId` the same way it carries SimpleFIN's `sfin_url`.

-- ---------------------------------------------------------------------------
-- Securities
-- ---------------------------------------------------------------------------

-- Provider-agnostic reference data, one row per security, shared by every
-- holding that references it (ADR 0004 decision 2). Keyed on the ticker rather
-- than a (provider, provider_security_id) pair — unlike a connection or an
-- account, a security is not a per-provider concept, and a ticker is its natural
-- identity for a single-user retail app.
create table public.financials_security (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  name text,
  -- Free text under a check, matching financials_account.kind: the vocabulary is
  -- this app's, not a provider's, and providers disagree about the boundaries.
  -- Anything a provider reports that doesn't map lands as 'other' with its raw
  -- code kept in `extra`, so a mapping this app got wrong stays visible and
  -- fixable rather than being silently rounded off.
  security_type text not null default 'other',
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financials_security_security_type_check check (
    security_type in (
      'equity', 'etf', 'mutual_fund', 'fixed_income', 'cash', 'crypto', 'option', 'other'
    )
  ),
  constraint financials_security_symbol_key unique (symbol)
);

-- ---------------------------------------------------------------------------
-- Holdings
-- ---------------------------------------------------------------------------

-- A snapshot of one security's position in one account, as of one sync. Append
-- on sync, never upsert (ADR 0004 decision 1): holdings carry no provider-issued
-- id to dedupe an overlapping re-fetch the way transactions do, so each sync
-- writes a fresh row and `as_of` distinguishes them. "Current holdings" is
-- therefore the latest `as_of` per (account, security), not a table.
create table public.financials_holding (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.financials_account (id) on delete cascade,
  security_id uuid not null references public.financials_security (id) on delete cascade,
  -- numeric, never float, and fractional: brokerages report partial shares.
  quantity numeric not null,
  -- Both per-unit (ADR 0004 decision 3). The totals are `* quantity` at read
  -- time — a second stored column could only ever drift from the first, and no
  -- provider hands this app a conflicting authoritative total worth keeping.
  average_cost_basis numeric,
  market_price numeric,
  -- Per holding, not per account: a foreign-listed ETF can be denominated
  -- differently than the account it sits in.
  currency text,
  -- ADR 0004 decision 4. Lot-level detail varies by brokerage and security, so
  -- this is jsonb and nullable rather than a child table that is usually empty.
  tax_lots jsonb,
  extra jsonb,
  -- When the position was true, as the provider reports it — not when this app
  -- fetched it. That is what makes a retried sync land on the same row instead
  -- of writing a second snapshot of the same reading.
  as_of timestamptz not null,
  created_at timestamptz not null default now(),
  -- Present per the ADR 0001 baseline; the trigger below is what ADR 0004
  -- decision 6 exempts this table from, not the column.
  updated_at timestamptz not null default now(),
  -- ADR 0004 decision 5. The insert is `on conflict do nothing`, so a sync that
  -- runs twice against one provider-side reading writes one row.
  constraint financials_holding_account_security_as_of_key
    unique (account_id, security_id, as_of)
);

-- The one read path: an account's holdings, newest snapshot first.
create index financials_holding_account_as_of_idx
  on public.financials_holding (account_id, as_of desc);

create index financials_holding_security_id_idx
  on public.financials_holding (security_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger financials_security_set_updated_at
  before update on public.financials_security
  for each row execute function public.set_updated_at();

-- financials_holding deliberately has none — ADR 0004 decision 6. Rows are
-- insert-only snapshots, so a BEFORE UPDATE trigger would never fire, and the
-- one thing it could tell you is already `created_at`.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.financials_security enable row level security;
alter table public.financials_holding enable row level security;

create policy financials_security_authorized on public.financials_security
  for all using (public.is_authorized()) with check (public.is_authorized());

create policy financials_holding_authorized on public.financials_holding
  for all using (public.is_authorized()) with check (public.is_authorized());

grant select, insert, update, delete on
  public.financials_security,
  public.financials_holding
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Destructive guards
-- ---------------------------------------------------------------------------
--
-- The same tripwires every other financials table carries
-- (20260802205533_financials_destructive_guards.sql). The drop guard already
-- covers these by name — it matches `financials\_%` — but the delete and
-- truncate guards are per-table triggers and have to be attached here.
--
-- These snapshots are as unrecoverable as the transaction history: SnapTrade
-- serves the *current* holdings, so a deleted snapshot is a hole in the record
-- that no re-sync fills.

do $$
declare
  t text;
begin
  foreach t in array array['financials_security', 'financials_holding'] loop
    execute format(
      'create trigger %I after delete on public.%I '
      || 'referencing old table as deleted for each statement '
      || 'execute function public.guard_bulk_delete()', t || '_guard_delete', t);

    execute format(
      'create trigger %I before truncate on public.%I '
      || 'for each statement execute function public.guard_truncate()',
      t || '_guard_truncate', t);
  end loop;
end $$;

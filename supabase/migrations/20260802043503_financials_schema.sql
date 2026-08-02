-- The Financials module's tables: connections, accounts, transactions, balance
-- snapshots, categories.
--
-- Shapes come from docs/adr/0002-financials-schema.md as amended by
-- docs/adr/0003-financials-multi-provider-and-account-kind.md (which renamed
-- every `simplefin_*` column to `provider_*` and added `financials_account.kind`),
-- on the baseline in docs/adr/0001-baseline-supabase-schema-conventions.md.
--
-- Deliberately absent: `financials_security` / `financials_holding`
-- (docs/adr/0004). Those belong to the SnapTrade holdings ticket; nothing here
-- needs them, and the ADR's shape is easier to land beside its own sync job.

-- The one shared BEFORE UPDATE trigger function ADR 0001 mandates, so no table
-- maintains `updated_at` from app code. Defined here rather than in the auth
-- baseline because this is the migration that first needs it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger keeping updated_at current. Attached to every module table (ADR 0001).';

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

-- One row per authenticated link to an institution — SimpleFIN's `conn_id`.
-- Separate from financials_account because two accounts can share a bank and
-- still belong to different logins.
create table public.financials_connection (
  id uuid primary key default gen_random_uuid(),
  -- ADR 0003: free text, not an enum, so a second provider is a new value
  -- rather than a migration. 'simplefin' today, 'snaptrade' next.
  provider text not null default 'simplefin',
  provider_conn_id text not null,
  name text not null,
  org_id text,
  -- Provider-specific connection metadata, including SimpleFIN's `sfin_url`,
  -- which ADR 0003 dropped as a named column.
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Scoped to the provider, not global: two providers' id spaces are unrelated,
  -- so a bare unique on provider_conn_id would invent a collision between them.
  constraint financials_connection_provider_conn_id_key unique (provider, provider_conn_id)
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table public.financials_account (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.financials_connection (id) on delete cascade,
  provider_account_id text not null,
  name text not null,
  -- ADR 0003: user-set at link time. No provider signals account type, so this
  -- can only ever be a default the user corrects — never something sync writes.
  kind text not null default 'depository',
  -- Wide text, not char(3): SimpleFIN's currency is usually ISO 4217 but is a
  -- URL for non-standard currencies like rewards points (research doc §2).
  currency text not null,
  balance numeric not null,
  available_balance numeric,
  balance_date timestamptz,
  -- ADR 0002 deviation 1: closure sets this rather than deleting the row, which
  -- would cascade away the transaction and snapshot history behind past
  -- net-worth figures.
  status text not null default 'active',
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financials_account_kind_check check (kind in ('depository', 'investment')),
  constraint financials_account_status_check check (status in ('active', 'closed')),
  -- DEVIATION from ADR 0002, which specified `simplefin_account_id text unique`
  -- (global), and which ADR 0003 renamed without restating. Scoped to the
  -- connection instead, for the same reason ADR 0003 gave for scoping
  -- financials_connection's key to the provider: two providers' account-id
  -- spaces are unrelated, and a global unique would invent a collision between
  -- a SimpleFIN account and a SnapTrade one that happen to share an id.
  --
  -- Flagged rather than assumed: ADR 0001 says deviating "requires revisiting
  -- this ADR, not a one-off table", so this is raised on issue #23 for ADR 0003
  -- to absorb or overrule.
  constraint financials_account_provider_account_id_key unique (connection_id, provider_account_id)
);

create index financials_account_connection_id_idx
  on public.financials_account (connection_id);

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

-- Entirely app-owned: SimpleFIN carries no categorization, so nothing syncs
-- into this table.
create table public.financials_category (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financials_category_name_key unique (name)
);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

create table public.financials_transaction (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.financials_account (id) on delete cascade,
  provider_transaction_id text not null,
  posted timestamptz not null,
  transacted_at timestamptz,
  -- Positive = deposit, negative = withdrawal, per SimpleFIN's convention.
  -- numeric, never float: amounts arrive as decimal strings.
  amount numeric not null,
  description text not null default '',
  pending boolean not null default false,
  -- Nullable and set null on delete: losing a category must not lose the
  -- transaction it was on.
  category_id uuid references public.financials_category (id) on delete set null,
  extra jsonb,
  -- ADR 0002's consequence: bumped on every upsert so the sync job can spot a
  -- pending transaction that vanished from a later poll. Without it there is no
  -- persisted signal separating "genuinely gone" from "outside this window".
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The upsert key. Polls re-fetch an overlapping window by design, so the same
  -- transaction is seen repeatedly and must land on one row.
  constraint financials_transaction_provider_transaction_id_key
    unique (account_id, provider_transaction_id)
);

-- Both read paths the module has: an account's transactions newest-first, and
-- spend grouped by category.
create index financials_transaction_account_posted_idx
  on public.financials_transaction (account_id, posted desc);

create index financials_transaction_category_id_idx
  on public.financials_transaction (category_id)
  where category_id is not null;

-- ---------------------------------------------------------------------------
-- Balance snapshots
-- ---------------------------------------------------------------------------

-- One row per account per poll. Net worth history reads from here rather than
-- summing transactions, because `balance_date` can lag or lead the transaction
-- feed and the sum would then disagree with the bank.
--
-- Rows are only ever inserted, so `updated_at` will not move — but ADR 0001's
-- baseline still applies. ADR 0004 granted an insert-only table an exemption
-- from the trigger explicitly, and scoped it to financials_holding; taking the
-- same exemption here without an ADR would be inventing one.
create table public.financials_balance_snapshot (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.financials_account (id) on delete cascade,
  balance numeric not null,
  available_balance numeric,
  balance_date timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index financials_balance_snapshot_account_balance_date_idx
  on public.financials_balance_snapshot (account_id, balance_date desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger financials_connection_set_updated_at
  before update on public.financials_connection
  for each row execute function public.set_updated_at();

create trigger financials_account_set_updated_at
  before update on public.financials_account
  for each row execute function public.set_updated_at();

create trigger financials_category_set_updated_at
  before update on public.financials_category
  for each row execute function public.set_updated_at();

create trigger financials_transaction_set_updated_at
  before update on public.financials_transaction
  for each row execute function public.set_updated_at();

create trigger financials_balance_snapshot_set_updated_at
  before update on public.financials_balance_snapshot
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
--
-- Exactly one `for all` policy per table calling is_authorized() — ADR 0001
-- rejected a per-operation split, since a single-user app has no read/write
-- permission boundary for four policies to express.
--
-- Privileges are granted to anon as well as authenticated for the reason the
-- auth baseline grants it execute on is_authorized(): without the grant an
-- unauthenticated query fails on permission instead of returning nothing, and
-- RLS is what actually decides. service_role is omitted — it bypasses RLS.

alter table public.financials_connection enable row level security;
alter table public.financials_account enable row level security;
alter table public.financials_category enable row level security;
alter table public.financials_transaction enable row level security;
alter table public.financials_balance_snapshot enable row level security;

create policy financials_connection_authorized on public.financials_connection
  for all using (public.is_authorized()) with check (public.is_authorized());

create policy financials_account_authorized on public.financials_account
  for all using (public.is_authorized()) with check (public.is_authorized());

create policy financials_category_authorized on public.financials_category
  for all using (public.is_authorized()) with check (public.is_authorized());

create policy financials_transaction_authorized on public.financials_transaction
  for all using (public.is_authorized()) with check (public.is_authorized());

create policy financials_balance_snapshot_authorized on public.financials_balance_snapshot
  for all using (public.is_authorized()) with check (public.is_authorized());

grant select, insert, update, delete on
  public.financials_connection,
  public.financials_account,
  public.financials_category,
  public.financials_transaction,
  public.financials_balance_snapshot
to anon, authenticated;

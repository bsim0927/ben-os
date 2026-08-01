# Financials module schema

**Status**: accepted

The Financials module (net worth + transaction history via SimpleFIN) needs Supabase tables covering connections, accounts, transactions, and net-worth history, following the baseline in [ADR 0001](./0001-baseline-supabase-schema-conventions.md). Five tables:

- **`financials_connection`** — one row per SimpleFIN `conn_id` (login/institution link): `simplefin_conn_id text unique`, `name`, `org_id`, `sfin_url`. Kept separate from `financials_account` because two accounts can share a bank but differ by connection (two logins to the same institution).
- **`financials_account`** — `connection_id` FK, `simplefin_account_id text unique`, `name`, `currency text` (plain text, unconstrained — SimpleFIN's currency is usually ISO 4217 but can be a URL for non-standard currencies like rewards points), `balance`, `available_balance`, `balance_date`, `status text default 'active'` (`'active' | 'closed'`), `extra jsonb`.
- **`financials_transaction`** — `account_id` FK, `simplefin_transaction_id text`, `posted`, `transacted_at`, `amount numeric` (positive = deposit, negative = withdrawal, per SimpleFIN's convention), `description`, `pending boolean`, `category_id` FK (nullable), `extra jsonb`, `last_synced_at timestamptz`. Unique on `(account_id, simplefin_transaction_id)` — the upsert/dedupe key, since the sync job re-fetches overlapping date windows by design (SimpleFIN's recommended ~5-day poll overlap).
- **`financials_balance_snapshot`** — `account_id` FK, `balance`, `available_balance`, `balance_date`. One row per account per poll. Net worth history is built from this table, not derived by summing transactions, because `balance_date` can lag or lead the transaction feed.
- **`financials_category`** — `name text unique`. User-driven; SimpleFIN provides no categorization natively.

## Deviations from ADR 0001

Two deliberate exceptions to the skeleton baseline, called out because a future reader would otherwise assume they're bugs:

1. **`financials_account.status` instead of hard delete.** ADR 0001 mandates hard-delete-only, but deleting an account row on real-world closure/revocation would cascade-delete its transaction and balance-snapshot history, corrupting past net-worth figures. Closure sets `status = 'closed'` instead of removing the row.
2. **The SimpleFIN Access URL is not a table.** It's a single Basic Auth credential covering the entire Bridge subscription (all linked institutions), not a per-connection or per-user value — structurally an API key, not domain data. It's stored as a server-side secret (Vercel/Supabase env var or Vault) read only by the backend sync job, never as a database row.

## Consequences

`financials_transaction.last_synced_at` is bumped on every upsert specifically so the sync job can detect pending transactions that silently disappeared from a later poll (a pending transaction can later post under a different SimpleFIN id) and prune them — without this column there's no persisted signal to distinguish "genuinely gone" from "outside this particular poll's date window."

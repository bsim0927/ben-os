# Financials holding schema

**Status**: accepted

Grilling session for the `financials_holding` design ([Wayfinder #16](https://github.com/bsim0927/ben-os/issues/16)), following the SnapTrade provider pick in [Research a brokerage/investment holdings data provider](https://github.com/bsim0927/ben-os/issues/14). Two new tables, built on the multi-provider baseline from [ADR 0003](./0003-financials-multi-provider-and-account-kind.md):

- **`financials_security`** — one row per security: `symbol text unique not null`, `name`, `security_type text` (`equity | etf | mutual_fund | fixed_income | cash | crypto | option | other`), `extra jsonb`.
- **`financials_holding`** — `account_id` FK, `security_id` FK, `quantity numeric`, `average_cost_basis numeric` (per-unit), `market_price numeric` (per-unit), `currency text`, `tax_lots jsonb`, `extra jsonb`, `as_of timestamptz`. Unique on `(account_id, security_id, as_of)`.

## Decisions

1. **`financials_holding` is append-on-sync, not upsert.** Unlike `financials_transaction` (which has stable provider ids to dedupe overlapping re-fetches), holdings are refetched wholesale on every sync with no per-holding provider id. Each sync inserts a fresh row per `(account_id, security_id)` with an `as_of` timestamp — `financials_holding` is holdings' `financials_balance_snapshot` equivalent. There's no separate "current-state" table; "current holdings" is `WHERE as_of = (max as_of per account)`, not a distinct table.
2. **`financials_security` is a separate reference table, not denormalized onto `financials_holding`.** Prevents the same security's metadata (symbol, name, type) being re-stored on every sync-snapshot row, across every account that holds it. Keyed `unique(symbol)` — a ticker is the natural identity for a single-user retail app. A `(provider, provider_security_id)` key (mirroring `financials_account.provider_account_id`) was considered and rejected: a security is a provider-agnostic concept, unlike a connection or account, which genuinely differ per provider.
3. **Cost basis and market value each store one number, not two.** `average_cost_basis` and `market_price` are per-unit; `total_cost_basis`/`market_value` are computed at read time (`* quantity`), not persisted. No provider gives this app a conflicting authoritative total worth preserving separately, so a second stored column could only drift from the first.
4. **`tax_lots jsonb`, nullable.** SnapTrade exposes lot-level detail inconsistently (varies by brokerage/security). A nullable jsonb column costs nothing when absent and needs no migration when it isn't, matching the `extra jsonb` pattern already used for sparse provider data elsewhere.
5. **`(account_id, security_id, as_of)` unique.** Makes the sync job idempotent (`ON CONFLICT DO NOTHING`) against accidental retry — holdings have no provider-issued id to dedupe against the way transactions do, but the sync job's own attempt at a given moment is naturally idempotent under this key.
6. **No `updated_at` trigger on `financials_holding`.** Deviates from the [ADR 0001](./0001-baseline-supabase-schema-conventions.md) baseline: rows are insert-only snapshots, never updated in place, so a trigger that would only ever fire at insert adds nothing `created_at` doesn't already provide.
7. **`financials_connection.provider = 'snaptrade'`** is a new value on the existing free-text column — no migration needed beyond usage. `financials_connection.extra` stores SnapTrade's `authorizationId` (the persistent Personal-mode connection identity), following the same pattern ADR 0003 established for provider-specific connection metadata. `financials_account.kind = 'investment'` and `provider_account_id` need no changes — a SnapTrade-linked account reuses both columns as-is.

## Consequences

- Querying "current holdings" means selecting the latest `as_of` per `security_id` per account, not a plain table scan — every read path needs a `DISTINCT ON`/window-function query.
- `financials_holding` grows unboundedly with every sync — nothing collapses it the way transaction dedup bounds `financials_transaction` growth. Acceptable at this app's single-user daily-sync scale; worth revisiting (e.g. pruning old snapshots) if it ever matters.
- `financials_account`/`financials_balance_snapshot` need no schema changes for SnapTrade's total account balance — `financials_holding`/`financials_security` are the only genuinely new tables this ticket adds, matching what the research doc (issue #14) anticipated.

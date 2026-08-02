# Financials schema: multi-provider connections + account kind

**Status**: accepted
**Supersedes**: parts of [ADR 0002](./0002-financials-schema.md) (marked inline there)

Grilling session, prompted by wanting to distinguish bank accounts from brokerage accounts. Two findings from the SimpleFIN research (issue #2) shaped the outcome:

- SimpleFIN's Account object is identical for every account type — `id`, `name`, `conn_id`, `currency`, `balance`, `balance-date`, `available-balance`, `transactions`, `extra`. No account-type field, and no holdings/positions/securities data anywhere in the protocol.
- A brokerage account's _balance_ can come through SimpleFIN like any other account, but real per-security holdings data cannot — that requires a second provider, not yet chosen, which needs its own research ticket before `financials_holding` (or equivalent) can be designed.

Decisions:

1. **`financials_account.kind text not null default 'depository'`** (allowed values `'depository' | 'investment'`, extensible). User-set at link time — SimpleFIN gives no signal to infer it from, the same reason `financials_category` is user-driven rather than synced.
2. **`financials_connection` generalizes off SimpleFIN-only.** Renamed/added: `provider text not null default 'simplefin'`, `simplefin_conn_id` → `provider_conn_id`. `sfin_url` is dropped as a named column; connection metadata specific to a provider (including SimpleFIN's server URL) moves into a new `extra jsonb` column, mirroring the pattern already used on `financials_account`/`financials_transaction`.
3. **Provider-specific ID columns generalize the same way**: `financials_account.simplefin_account_id` → `provider_account_id`, `financials_transaction.simplefin_transaction_id` → `provider_transaction_id`. Uniqueness/dedupe semantics are unchanged — `(account_id, provider_transaction_id)` is still the upsert key — only the column name changes.
4. **No holdings table yet.** Real per-security holdings/positions support is in scope for the Financials vertical (not deferred to a future wayfinder map the way Email/Calendar/Notetaking are), but is blocked on a new research ticket into a second data provider, since none of this is inferable from SimpleFIN.

## Consequences

- Every future provider (the eventual holdings provider included) plugs into `financials_connection`/`financials_account` via `provider` + `provider_conn_id`/`provider_account_id` rather than assuming SimpleFIN is the only source, so adding one doesn't require another rename pass.
- `kind` has no relationship to which provider an account came from — a `'depository'` and an `'investment'` account can both come from SimpleFIN (SimpleFIN carries balance for either), or from different providers entirely. The two concepts are orthogonal.
- The `financials_holding` shape (and whether it reuses `financials_transaction` for trade activity or needs its own table) is intentionally left open pending the holdings-provider research ticket — this ADR does not speculate on it.

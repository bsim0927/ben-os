# ben-os

A single-user personal platform (TypeScript/Next.js on Vercel, Supabase backend) that consolidates personal-admin tools — starting with a Financials vertical, with Email, Calendar, and Notetaking planned as future verticals.

## Language

**Module**:
A self-contained feature area (e.g. Financials) living under `apps/web/app/(modules)/<name>/`, registered in a central module registry, and owning its own prefix-namespaced Supabase tables (`<module>_<entity>`).
_Avoid_: Vertical (used loosely in planning discussions, but "module" is the concrete code/schema unit), plugin, feature.

**Module registry**:
The list in `apps/web/lib/modules.ts` that declares every module — its label, icon, route, and whether it's built yet. It governs enablement, not just routing: a module with `status: "soon"` still appears in the shell, dimmed and inert. Registering a module means adding one entry here.
_Avoid_: Nav config, routes — the registry is the source of truth for what modules exist, and navigation is only one thing it drives.

**Shell**:
The persistent chrome every module renders inside: the left sidebar (module list plus account chip) and the crumb row (`<Module> / <page>` plus a sync-status chip). The shell owns exactly those two things and never reaches into module content. Its visual identity is "Console" — dense, dark-first, hairline borders, tabular numerals, one accent color.
_Avoid_: Layout (ambiguous with Next.js's `layout.tsx` files, of which modules have their own), chrome, frame.

**Authorized user**:
The single Google account permitted to use the app. Enforced in two places: a middleware/layout check at the app layer, and the `is_authorized()` Postgres function as an RLS backstop at the database layer.
_Avoid_: Owner, admin — this app has no multi-tenant or role concept, there is exactly one authorized user.

### Financials module

**Provider**:
The external data source a connection authenticates against (e.g. SimpleFIN; a future brokerage-holdings provider). Every connection belongs to exactly one provider.

**Connection**:
A single login/institution link to a specific provider (e.g. SimpleFIN's `conn_id`). One connection can expose multiple accounts; the same institution can have more than one connection if linked more than once.
_Avoid_: Institution, bank — a connection is one authenticated link to an institution, not the institution itself.

**Account**:
A single financial account (checking, savings, credit card, brokerage, etc.) exposed by a connection, with a live balance synced from its provider. Distinguished by `kind` (`'depository' | 'investment'`), which is user-set — no provider signals account type natively.

**Balance snapshot**:
A point-in-time record of an account's balance as reported by a provider poll — the basis for net worth history, distinct from the account's current balance.
_Avoid_: Balance (ambiguous between "the account's current balance" and "a historical snapshot")

**Net worth**:
The sum of every Account's balance at a point in time, derived from Balance snapshots at read time and never stored. Its unit is a UTC day: an account's last reading of a day wins, an account that missed a poll carries its previous balance forward, and a closed account contributes up to its last snapshot and no further. See [ADR 0006](docs/adr/0006-net-worth-derivation-and-charting.md).
_Avoid_: Total balance — net worth is the sum across accounts, and "balance" already belongs to a single account.

**Poll**:
One scheduled call to a provider, covering every Connection at once — SimpleFIN answers `GET /accounts` for the whole subscription, not per institution. A poll succeeds or fails _per Connection_, so "the poll failed" is almost always wrong; one bank being broken is the normal case.
_Avoid_: Sync, when the unit matters — a Sync is the job, a Poll is one run of it.

**Poll window**:
The date range a poll asks for. Steady state is a 5-day overlap rather than "since last sync", because institutions post transactions late and a cursor would step over them; re-fetching is free because transactions dedupe on `(account_id, provider_transaction_id)`. The first poll against an empty database reaches back 45 days instead — see [ADR 0005](docs/adr/0005-financials-sync-execution-model.md).

**Category**:
A user-assigned label on a transaction. SimpleFIN provides no native categorization, so this is entirely app-owned.
_Avoid_: Tag — categories are single-valued per transaction in v1, not a many-valued tagging system.

**Security**:
A tradable financial instrument (stock, ETF, mutual fund, etc.), identified by ticker symbol. Provider-agnostic reference data, shared across every Holding that references it.
_Avoid_: Ticker, symbol, instrument — "Security" is the entity; a ticker/symbol is one of its fields.

**Holding**:
A snapshot of a Security's position within an Account as of a given sync — quantity, cost basis, market price. A new row is written on every sync (not upserted), so "current holdings" means the latest snapshot per Account/Security pair, not a standing record.
_Avoid_: Position — used in the SnapTrade research as an interchangeable term, but "Holding" is this codebase's canonical word.

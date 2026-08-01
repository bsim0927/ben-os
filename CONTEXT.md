# ben-os

A single-user personal platform (TypeScript/Next.js on Vercel, Supabase backend) that consolidates personal-admin tools — starting with a Financials vertical, with Email, Calendar, and Notetaking planned as future verticals.

## Language

**Module**:
A self-contained feature area (e.g. Financials) living under `apps/web/app/(modules)/<name>/`, registered in a central module registry, and owning its own prefix-namespaced Supabase tables (`<module>_<entity>`).
_Avoid_: Vertical (used loosely in planning discussions, but "module" is the concrete code/schema unit), plugin, feature.

**Authorized user**:
The single Google account permitted to use the app. Enforced in two places: a middleware/layout check at the app layer, and the `is_authorized()` Postgres function as an RLS backstop at the database layer.
_Avoid_: Owner, admin — this app has no multi-tenant or role concept, there is exactly one authorized user.

### Financials module

**Connection**:
A single SimpleFIN login/institution link (SimpleFIN's `conn_id`). One connection can expose multiple accounts; the same institution can have more than one connection if linked more than once.
_Avoid_: Institution, bank — a connection is one authenticated link to an institution, not the institution itself.

**Account**:
A single financial account (checking, savings, credit card, etc.) exposed by a connection, with a live balance synced from SimpleFIN.

**Balance snapshot**:
A point-in-time record of an account's balance as reported by a SimpleFIN poll — the basis for net worth history, distinct from the account's current balance.
_Avoid_: Balance (ambiguous between "the account's current balance" and "a historical snapshot")

**Category**:
A user-assigned label on a transaction. SimpleFIN provides no native categorization, so this is entirely app-owned.
_Avoid_: Tag — categories are single-valued per transaction in v1, not a many-valued tagging system.

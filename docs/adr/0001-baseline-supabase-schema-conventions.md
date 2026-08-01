# Baseline Supabase schema conventions for every module table

**Status**: accepted

ben-os is a single-user app with a full Supabase schema redesign from a clean slate. Every module (Financials first, then Email/Calendar/Notetaking) needs a consistent baseline so tables are safe by default and predictable to read. We decided:

- **Auth gate**: a single `is_authorized()` SQL function (`SECURITY DEFINER`) checks `auth.jwt() ->> 'email'` against the one allowed email, hardcoded as a string literal in the function body. Every module table's RLS policy calls it — this is the RLS backstop behind the app-layer middleware/layout check, so it must not depend on app code being correct.
- **RLS policy shape**: exactly one `FOR ALL USING (is_authorized()) WITH CHECK (is_authorized())` policy per table, not a per-operation (SELECT/INSERT/UPDATE/DELETE) split.
- **Naming**: snake_case; tables named `<module>_<entity>` (e.g. `financials_account`) in the `public` schema — no schema-per-module.
- **Primary keys**: `id uuid primary key default gen_random_uuid()`.
- **Timestamps**: `created_at` / `updated_at timestamptz`, with `updated_at` kept current by a single shared `BEFORE UPDATE` trigger function — not app code.
- **Deletes**: hard delete only, no `deleted_at`.
- **Users**: no `public.profile` table — auth relies purely on `auth.users` plus the JWT `email` claim.

## Considered options

- **Allowed email as a Postgres GUC** (`current_setting('app.allowed_email')`) instead of hardcoded — rejected because it adds indirection outside version-controlled SQL for a value that changes only via deliberate migration.
- **Per-operation RLS policies** (four per table) — rejected as unnecessary ceremony; this is a single-user app with no read/write permission split, so one `FOR ALL` policy is equivalent and simpler.
- **Schema-per-module** (`financials.account`) instead of a table-name prefix — rejected; adds cross-schema `search_path`/grant complexity that a single-user app with no tenant isolation need doesn't justify.
- **Soft delete (`deleted_at`) baseline** — rejected as default; it forces every query and RLS policy to filter `deleted_at IS NULL` app-wide for a recovery feature no module has asked for yet. Can be added per-table later if a module needs it.
- **`public.profile` table mirroring `auth.users`** — rejected; there's no per-user settings/display data to store yet for a single hardcoded user.

## Consequences

Every future module migration must define `is_authorized()`-backed RLS, follow the naming/id/timestamp shape above, and attach the shared `updated_at` trigger — deviating requires revisiting this ADR, not a one-off table.

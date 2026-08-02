## Agent skills

### Issue tracker

Issues tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

### Database

Supabase project `fcqoliweobjhpgqfgxao` exists and is live. Reach it through the **Supabase MCP
server**, not dashboard clicks or ad-hoc `psql` — setup and its pitfalls are in README, "Inspecting
and changing the database". The server runs without `--read-only`, so it can apply DDL.

The pre-ADR schema has been wiped (`20260802040000_wipe_pre_adr_schema.sql`). `public` now holds
exactly one object — `is_authorized()`, the RLS backstop — so the Financials tables are the first
thing built on a clean slate. Schema conventions every table must follow are in
`docs/adr/0001-baseline-supabase-schema-conventions.md`.

## Agent skills

### Issue tracker

Issues tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

### Database

Supabase project `fcqoliweobjhpgqfgxao` exists and is live. Reach it through the **Supabase MCP
server**, not dashboard clicks or ad-hoc `psql` — setup and its pitfalls are in README, "Inspecting
and changing the database". The server runs without `--read-only`, so it can apply DDL.

The pre-ADR schema has been wiped (`20260802040000_wipe_pre_adr_schema.sql`) and the Financials
tables built on the clean slate (`20260802043503_financials_schema.sql`). `public` holds
`is_authorized()`, `set_updated_at()`, and the five `financials_*` tables. Schema conventions every
table must follow are in `docs/adr/0001-baseline-supabase-schema-conventions.md`.

> [!IMPORTANT]
> **Those tables hold real data now** — a linked SimpleFIN account syncing Chase and Fidelity daily.
> This project stopped being a scratch database on 2026-08-02. Destructive SQL loses transaction
> history that cannot be re-fetched, because Bridge only serves a bounded recent window. Prefer
> additive migrations, and confirm before any `truncate`/`drop` touching `financials_*`.

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
`is_authorized()`, `set_updated_at()`, and the seven `financials_*` tables — the five from that
migration plus `financials_security` and `financials_holding`
(`20260803025805_financials_holding_schema.sql`, per ADR 0004). Schema conventions every
table must follow are in `docs/adr/0001-baseline-supabase-schema-conventions.md`.

> [!IMPORTANT]
> **Those tables hold real data now** — a linked SimpleFIN account syncing Chase and Fidelity daily.
> This project stopped being a scratch database on 2026-08-02. Destructive SQL loses transaction
> history that cannot be re-fetched, because Bridge only serves a bounded recent window. Prefer
> additive migrations, and confirm before any `truncate`/`drop` touching `financials_*`.

Database guards enforce that (`20260802205533_financials_destructive_guards.sql`): `truncate` on a
`financials_*` table, `drop` of one, and any single `delete` of more than 100 rows all raise. If a
destructive statement fails with "Refusing to…", **that is the guard working — do not route around
it.** Stop and ask, unless the user has just asked for exactly that operation. When they have:

```sql
begin;
set local ben_os.allow_bulk_delete = 'on';
-- the statement
commit;
```

`set local` scopes the opt-in to that one transaction. Never set it session-wide, and never disable
or drop the triggers to get a statement through — the guard is cheap to satisfy honestly and its
whole value is that bypassing it has to be a decision someone made on purpose.

A `PreToolUse` hook (`.claude/hooks/guard-supabase-sql.py`, registered in `.claude/settings.json`)
catches the same statements one layer earlier, before they reach the database — including the ones
that would disable the database guards. It reads the same `ben_os.allow_bulk_delete` opt-in, so
there is one convention rather than two. If it blocks something, **that is not a puzzle to solve by
rephrasing the SQL**: stop and ask.

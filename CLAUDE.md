## Agent skills

### Issue tracker

Issues tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

### Database

Supabase project `fcqoliweobjhpgqfgxao` exists and is live. Reach it through the **Supabase MCP
server**, not dashboard clicks or ad-hoc `psql` — setup and its pitfalls are in README, "Inspecting
and changing the database". The server runs without `--read-only`, so it can apply DDL.

Its schema is still the pre-ADR design and needs a full wipe and clean-slate redesign; nothing
currently in `public` is worth preserving. Schema conventions every table must follow are in
`docs/adr/0001-baseline-supabase-schema-conventions.md`.

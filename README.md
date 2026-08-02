# ben-os

Personal admin console. pnpm monorepo, TypeScript end-to-end, deployed to Vercel.

## Layout

| Path          | What                                                              |
| ------------- | ----------------------------------------------------------------- |
| `apps/web`    | Next.js (App Router) dashboard — the only real build target today |
| `apps/mobile` | Expo placeholder, deliberately unbuilt (see its README)           |
| `supabase/`   | Migrations and local CLI config for the Supabase backend          |
| `docs/adr/`   | Architecture decision records                                     |

`packages/` is intentionally absent — it gets created when a real cross-app sharing need appears,
not before.

## Prerequisites

Node 22 (see `.nvmrc`) and pnpm via corepack:

```sh
nvm use
corepack enable
```

## Commands

Run from the repo root; each fans out across workspace packages that define the script.

```sh
pnpm install        # install all workspace deps
pnpm dev            # run apps/web in dev mode
pnpm lint           # eslint, zero warnings tolerated
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm build          # next build
pnpm format         # prettier --write .
```

## Auth

One Google account can use this app. Nothing else gets in, and that's enforced in two independent
places:

- **App layer** — `apps/web/proxy.ts` runs on every request and turns away anyone who isn't the
  allowed account; `app/(modules)/layout.tsx` checks again before rendering the shell. Two checks,
  because a routing mistake in one should cost a redirect, not the app's privacy.
  Two prefixes are exempt, and only two: `/auth`, which is the sign-in round trip itself, and
  `/api/cron`, reached by a scheduler that has no Google session and never can. Cron routes gate on
  a bearer secret instead (`lib/cron.ts`), and fail closed when it isn't set.
- **Database** — `public.is_authorized()` (`supabase/migrations/`) compares the JWT's `email` claim
  against the same address. Per [ADR 0001](docs/adr/0001-baseline-supabase-schema-conventions.md),
  every module table's RLS policy calls it, so data stays protected even if the app layer is wrong.

The allowed address is hardcoded in both halves — `ALLOWED_EMAIL` in `apps/web/lib/auth.ts` and the
string literal inside `is_authorized()`. **They are a pair: changing the authorized account means
editing both.** There is no `public.profile` table; auth relies on `auth.users` plus the JWT claim.

### The Supabase project

The hosted project already exists: ref **`fcqoliweobjhpgqfgxao`** (`us-east-2`), at
`https://fcqoliweobjhpgqfgxao.supabase.co`.

> [!IMPORTANT]
> **Its schema is not the one this repo describes.** The project predates these ADRs and still holds
> the earlier design. It needs a full wipe and clean-slate redesign before the Financials tables
> land — treat everything currently in `public` as disposable. There is no data worth preserving,
> which is exactly why [#20](https://github.com/bsim0927/ben-os/issues/20) specifies a redesign from
> scratch rather than a migration path.
>
> `supabase/migrations/20260802040000_wipe_pre_adr_schema.sql` performs that wipe. It is idempotent,
> and it also prunes the migration-history rows left behind by the earlier design, so apply it before
> writing any `financials_*` migration.

Remaining setup — dashboard settings that can't live in this repo:

1. Create a Google OAuth client (Google Cloud Console → Credentials), with
   `https://fcqoliweobjhpgqfgxao.supabase.co/auth/v1/callback` as an authorized redirect URI.
2. In the Supabase dashboard, enable **Google** under Authentication → Providers and paste the
   client ID and secret. Disable the **Email** provider outright — it would let someone register the
   allowed address directly and walk past the whole restriction.
   Then close registration under **User Signups → "Allow new users to sign up"**, but only _after_
   signing in once: against an empty `auth.users`, the first Google sign-in is a signup, so closing
   it first makes GoTrue reject the sign-in with "Signups not allowed for this instance" and the app
   shows nothing but `/login?error=signin_failed`.
3. Set Site URL and add `<deployment>/auth/callback` to the redirect allow-list. Preview deployments
   need a wildcard — Vercel varies the segment _after_ the project name, so the pattern is
   `https://<project>-*-<scope>.vercel.app/auth/callback`.
4. Apply the migrations: `supabase db push`.
5. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the project URL and anon key.
6. On any deployed environment, set `NEXT_PUBLIC_SITE_URL` to that deployment's public origin. The
   sign-in callback builds its redirect from it — behind a proxy the request's own origin is the
   internal one, and the `x-forwarded-host` header is not trusted for this because any caller can
   set it.

`supabase/config.toml` mirrors 1–3 for local development (`supabase start`), reading the Google
credentials from a root `.env` — see `.env.example`.

### Inspecting and changing the database

**Use the Supabase MCP server.** It is the supported way to read schema, run SQL, and apply
migrations against this project — prefer it over dashboard clicking or ad-hoc `psql`, so that what
was actually run is visible in the transcript.

Install once, at user scope, pinned to this project:

```sh
claude mcp add supabase --scope user \
  -e PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin \
  -e SUPABASE_ACCESS_TOKEN=<personal-access-token> \
  -- npx -y @supabase/mcp-server-supabase@latest --project-ref=fcqoliweobjhpgqfgxao
```

Four things that are easy to get wrong:

- The credential is a **personal access token** (`sbp_…`, from Supabase → Account → Access Tokens),
  _not_ a project API key. It grants account-wide authority — `--project-ref` is what confines the
  server to ben-os. It lives in `~/.claude.json` and must never be committed.
- `-e PATH=…` is required wherever Node comes from nvm. `npx` is a `#!/usr/bin/env node` script and
  a spawned MCP server doesn't inherit an interactive shell's PATH, so without it the server dies as
  an opaque `Connection closed`. Point it at the directory holding `node` (`nvm which current`).
- MCP servers connect at **session start**. After installing, restart Claude Code — and note that
  subagents inherit the parent session's connections, so spawning one won't pick up a new server.
- It runs **without** `--read-only`, so it can apply migrations and DDL. That's deliberate, and
  worth remembering before pointing it at anything.

## Adding a module

Add one entry to `apps/web/lib/modules.ts`, then create `app/(modules)/<name>/`. The sidebar, its
dimming, and the crumb row all read from that registry — nothing in the shell hardcodes a module.
Modules that aren't built yet stay in the registry with `status: "soon"`, and render dimmed with a
"Soon" tag rather than being hidden.

## Financials

The first module with real data behind it. Its tables (`financials_*`) follow
[ADR 0002](docs/adr/0002-financials-schema.md) as amended by
[ADR 0003](docs/adr/0003-financials-multi-provider-and-account-kind.md); the protocol notes behind
the sync are in [`docs/research/simplefin-bridge-api.md`](docs/research/simplefin-bridge-api.md).

`/financials` today is a **raw-data view** — accounts, balance snapshots and transactions as plain
tables. It exists to make sync correctness visible, and the designed surfaces (net worth, the flow
view, the Fidelity balance bridge, holdings) come in later tickets.

### Linking SimpleFIN

A Setup Token is redeemable **exactly once**. Generate one in SimpleFIN Bridge, then, signed in as
the authorized account:

```sh
curl -X POST https://<deployment>/api/financials/claim \
  -H 'Content-Type: application/json' \
  -b '<your session cookies>' \
  -d '{"setupToken":"<token>"}'
```

The response carries the **Access URL**. Nothing stores it — put it in `SIMPLEFIN_ACCESS_URL`
straight away, because claiming again returns `403` and a new token is the only way back.
Per [ADR 0002](docs/adr/0002-financials-schema.md) it stays a server-side secret and never becomes a
database row: it is one Basic Auth credential covering the whole Bridge subscription, so a database
leak must not also be a bank leak.

### The scheduled sync

`apps/web/vercel.json` runs `/api/cron/financials-sync` **once a day, at 11:37 UTC**. The odd minute
is what Bridge asks for, to keep clients off the top of the hour.

Daily rather than hourly for two reasons. The binding one is that **Vercel's Hobby plan permits only
daily cron**, and rejects a more frequent expression at deploy time — this is a build error, not a
silent downgrade. The other is that daily is the better fit anyway: net worth is a trend, one
observation a day draws it fine, and it leaves Bridge's ~24 requests/day budget almost untouched
instead of sitting exactly at the ceiling with nothing spare for a manual re-run.

If you ever want it more frequent, the choice is Vercel Pro, or a scheduled GitHub Actions workflow
that `curl`s the route with `CRON_SECRET` — the route doesn't care who calls it.

Each poll fetches an overlapping **5-day** window rather than "everything since last sync", because
institutions post transactions late — the overlap is free, since
`(account_id, provider_transaction_id)` dedupes it. Five days comfortably covers a daily cadence:
the window only has to exceed the gap between polls plus however late an institution posts.

The **first** poll is the exception: against an empty database a 5-day window would mean history
began five days ago, and no later poll would go back for the rest, so the first one asks for the
full 90 days a single call may cover. That is a cold start, not a backfill — deeper history would
need a separate job walking successive 90-day windows against the same daily budget, and how far
back an institution will go varies anyway.

Three behaviours worth knowing before reading the code:

- **One transaction per connection, not per poll.** Postgres aborts a whole transaction on the first
  failed statement, so a shared one would let a single broken connection roll back everybody
  else's writes. Per-connection units are what make `errlist`'s partial failures survivable.
- **The job runs under RLS.** It connects with `DATABASE_URL`, then drops to `authenticated` and
  presents the authorized email as a JWT claim (`lib/financials/db.ts`). The service role would have
  been easier and would have bypassed every policy — which would make the sync the one client that
  never tests the backstop ADR 0001 exists to provide.
  Both settings are established **inside each transaction**, not once per connection. That is what
  makes any of Supabase's connection strings safe to use: a pooler in transaction mode gives each
  transaction its own backend, so session-level settings could land on one that is released before
  the work runs — leaving it as the superuser the pool dialled, with `BYPASSRLS`, and nothing would
  fail. The writes would succeed and the backstop would be silently gone.
- **Sync never writes user-owned columns.** `financials_account.kind`, `.status`, and
  `financials_transaction.category_id` are set by the user and pointedly absent from every `on
conflict do update` list, so a poll can't undo a categorization or reopen a closed account.
  Nothing yet _sets_ `status = 'closed'` — that is a user action, arriving with the UI that offers
  it. Sync deliberately won't infer closure from an account's absence: a broken connection returns
  no accounts either, and guessing wrong would drop a live account out of net worth.

> [!IMPORTANT]
> Vercel's Hobby plan allows at most **two** cron jobs, each running **at most once a day**. A
> sub-daily expression fails the deploy outright with "This cron expression would run more than once
> per day" — so `vercel.json` is not a free place to raise the cadence.

### Testing the sync

`pnpm test` starts a **real Postgres 17** (`embedded-postgres`, no Docker required), applies
`supabase/migrations/` on top of a minimal Supabase bootstrap — the three roles, `auth.jwt()` — and
runs the sync against it with RLS switched on and fixture SimpleFIN responses served through a
stubbed `fetch`. It costs well under a second and needs nothing installed.

That is worth the dependency because this job's behaviour largely _is_ SQL: the upsert keys that
make an overlapping poll idempotent, the predicate that prunes a vanished pending transaction, and
the policies that decide whether the job may write at all. A fake query layer would only assert that
the tests agree with themselves.

## Quality gates

Two layers, deliberately asymmetric:

- **Pre-commit** (Husky + lint-staged) runs Prettier and ESLint on _staged files only_. Fast, so
  it never tempts a `--no-verify`. It does not typecheck or test.
- **CI** (`.github/workflows/ci.yml`) runs format check, lint, typecheck, and test on every push
  and PR. This is the real gate — it holds even when hooks are missing on a fresh clone or bypassed.

`main` is unprotected: direct pushes are allowed and no PR is required. That's a deliberate
solo-development choice, and it's why CI runs on `push` rather than only on `pull_request`.

## Deploying

Vercel project settings:

- **Root Directory**: `apps/web`
- **Include source files outside of the Root Directory**: on (needed for the pnpm workspace)

Build/install commands are auto-detected; the root `packageManager` field pins pnpm for the build.

Environment variables, from `apps/web/.env.example`. The first three are needed to render anything;
the last three are needed for the Financials sync, and are **secrets** — none may be given a
`NEXT_PUBLIC_` name, which would publish them in the browser bundle:

| Variable                        | Why                                                    |
| ------------------------------- | ------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Project URL                                            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key; RLS is what protects the data         |
| `NEXT_PUBLIC_SITE_URL`          | This deployment's own origin, for the sign-in redirect |
| `SIMPLEFIN_ACCESS_URL`          | The claimed SimpleFIN credential                       |
| `DATABASE_URL`                  | Direct Postgres, for the sync job only                 |
| `CRON_SECRET`                   | Gates `/api/cron/*`; Vercel Cron sends it as a bearer  |

`vercel.json` lives in `apps/web/` rather than the repo root, because Vercel reads it relative to the
Root Directory above.

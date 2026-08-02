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

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

### Setting up a Supabase project

Steps that can't live in this repo, because they're dashboard settings:

1. Create a Google OAuth client (Google Cloud Console → Credentials), with
   `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI.
2. In the Supabase dashboard, enable **Google** under Authentication → Providers and paste the
   client ID and secret. Leave email/password sign-up disabled — it would let someone register the
   allowed address directly and walk past the whole restriction.
3. Set Site URL and add `<deployment>/auth/callback` to the redirect allow-list.
4. Apply the migrations: `supabase db push`.
5. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the project URL and anon key.
6. On any deployed environment, set `NEXT_PUBLIC_SITE_URL` to that deployment's public origin. The
   sign-in callback builds its redirect from it — behind a proxy the request's own origin is the
   internal one, and the `x-forwarded-host` header is not trusted for this because any caller can
   set it.

`supabase/config.toml` mirrors 1–3 for local development (`supabase start`), reading the Google
credentials from a root `.env` — see `.env.example`.

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

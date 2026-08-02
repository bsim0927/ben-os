# ben-os

Personal admin console. pnpm monorepo, TypeScript end-to-end, deployed to Vercel.

## Layout

| Path          | What                                                              |
| ------------- | ----------------------------------------------------------------- |
| `apps/web`    | Next.js (App Router) dashboard — the only real build target today |
| `apps/mobile` | Expo placeholder, deliberately unbuilt (see its README)           |
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

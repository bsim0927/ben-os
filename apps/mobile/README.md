# @ben-os/mobile

Expo placeholder. **Deliberately unbuilt** — this package exists so the monorepo shape
accommodates a future React Native app (notetaking sync) without a later restructure.

It has no dependencies and no `lint`/`typecheck`/`test` scripts, so the root `pnpm -r --if-present`
scripts and CI skip it. That keeps `pnpm install` from pulling the full React Native toolchain
before anything actually uses it.

## When this gets built

Scaffold in place with Expo's own generator, then add the standard scripts so CI picks it up
automatically:

```sh
pnpm create expo-app@latest . --template
```

`app.json` holds the app identity (name/slug) so it survives that scaffold rather than being
re-invented.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import type { GlobalSetupContext } from "vitest/node";

/**
 * Starts one real Postgres for the whole test run.
 *
 * Real, rather than a stand-in, because the financials sync's behaviour *is*
 * SQL: the upsert keys that make an overlapping poll idempotent, the predicate
 * that prunes a vanished pending transaction, and the RLS policies that decide
 * whether the job may write at all. A fake query layer would assert that the
 * test's own model of those is self-consistent, which is worth nothing.
 *
 * Embedded rather than Docker so `pnpm test` needs nothing installed — the
 * binaries ship in `@embedded-postgres/linux-x64` and start in well under a
 * second. Postgres 17 matches the hosted Supabase project's major version.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../supabase/migrations", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    financialsDatabaseUrl: string;
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const databaseDir = await mkdtemp(join(tmpdir(), "ben-os-pgdata-"));
  const port = await freePort();

  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // The server's own log would otherwise interleave with vitest's reporter.
    onLog: () => {},
  });

  try {
    await postgres.initialise();
    await postgres.start();
  } catch (cause) {
    // The one failure mode worth naming: pnpm blocks dependency build scripts by
    // default, and without `@embedded-postgres/linux-x64`'s postinstall the
    // shipped binaries can't find their own shared libraries. The raw error is
    // an opaque `libpq.so.5: cannot open shared object file`.
    throw new Error(
      `Could not start the embedded Postgres the financials tests need. If this is a ` +
        `"cannot open shared object file" error, run \`pnpm rebuild\` — the binaries' ` +
        `postinstall is gated by allowBuilds in pnpm-workspace.yaml.\n\n${String(cause)}`,
      { cause },
    );
  }

  const client = postgres.getPgClient();
  await client.connect();

  try {
    await client.query(SUPABASE_BOOTSTRAP);

    for (const migration of await migrationsInOrder()) {
      await client.query(migration);
    }
  } finally {
    await client.end();
  }

  provide("financialsDatabaseUrl", `postgresql://postgres:postgres@localhost:${port}/postgres`);

  return async () => {
    await postgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}

/**
 * The parts of a Supabase database the migrations lean on.
 *
 * Only what they actually reference: the three roles, `auth.jwt()`, and the
 * migration-history table the wipe migration deletes rows from. Notably this
 * does *not* include GoTrue or PostgREST — the sync job talks to Postgres
 * directly, so nothing above the database is in the path being tested.
 */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  grant usage on schema public to anon, authenticated, service_role;

  create schema if not exists auth;
  grant usage on schema auth to anon, authenticated, service_role;

  -- Copied from the hosted project (verified against fcqoliweobjhpgqfgxao). If
  -- this drifted from Supabase's real definition, is_authorized() would be
  -- tested against a gate that doesn't exist in production.
  create or replace function auth.jwt()
  returns jsonb
  language sql
  stable
  as $$
    select
      coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb
  $$;

  grant execute on function auth.jwt() to anon, authenticated, service_role;

  -- Supabase's CLI keeps applied versions here; the wipe migration prunes rows
  -- from it, so it has to exist before the migrations run.
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    statements text[],
    name text
  );
`;

async function migrationsInOrder(): Promise<string[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();

  return Promise.all(names.map((name) => readFile(join(MIGRATIONS_DIR, name), "utf8")));
}

/** Port 0 lets the OS pick, so parallel runs of the suite can't collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine a free port."));

        return;
      }

      server.close(() => resolve(address.port));
    });
  });
}

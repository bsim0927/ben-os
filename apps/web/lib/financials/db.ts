/**
 * The sync job's database connection.
 *
 * Unlike the rest of the app, the sync job has no signed-in user and so no
 * Supabase session to borrow — it runs from cron. The easy answer would be the
 * service role, which bypasses RLS entirely; this deliberately doesn't take it.
 * Instead the session drops to the `authenticated` role and presents the
 * authorized user's email as a JWT claim, so `is_authorized()` is evaluated on
 * every statement the job runs.
 *
 * That keeps ADR 0001's backstop honest: if a policy were wrong, the sync job
 * would fail like any other caller instead of being the one client that never
 * tests it.
 */

import { Pool } from "pg";

import { ALLOWED_EMAIL } from "@/lib/auth";

import type { QueryFn } from "./store";

/**
 * Runs one atomic piece of work and hands back its result.
 *
 * The sync job's unit is a single connection, not the whole poll. That is a
 * correctness requirement rather than a preference: Postgres aborts an entire
 * transaction on the first failed statement, so one connection's bad data
 * inside a shared transaction would take every other connection's writes down
 * with it — exactly the failure per-connection isolation exists to prevent.
 */
export type UnitOfWork = <T>(body: (query: QueryFn) => Promise<T>) => Promise<T>;

let pool: Pool | undefined;

/**
 * SSL is left to the connection string (`?sslmode=require` / `no-verify`) rather
 * than hardcoded, because the right answer differs between Supabase's custom CA
 * and a local test server, and only the URL knows which one it points at.
 */
export function financialsPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set on this deployment. Copy a connection string from " +
          "Supabase → Connect, append ?sslmode=no-verify, and redeploy — variables are read " +
          "at build time, so a running deployment keeps the ones it was built with.",
      );
    }

    // Parsed here purely to fail with a message that names the culprit. `pg`
    // rejects a malformed string with a bare "Invalid URL", which — arriving in
    // a route that handles two other URLs as well — says nothing about which
    // one, let alone why.
    //
    // The causes named below are the ones that actually throw, checked rather
    // than assumed — the intuitive guesses are mostly wrong. A leftover
    // `[YOUR-PASSWORD]` placeholder parses fine, and so does an unencoded `@` in
    // the password: the URL spec splits on the *last* `@`, so the host survives.
    // What genuinely breaks it is a `#` or `/` in the password, quotes around
    // the value, or the `psql '…'` line from Supabase's Connect dialog pasted
    // whole instead of the URL inside it.
    try {
      new URL(connectionString);
    } catch {
      throw new Error(
        "DATABASE_URL is not a valid URL. Three things cause this: the value is the " +
          "`psql '…'` command from Supabase's Connect dialog rather than the bare URL " +
          "inside it; the value is wrapped in quotes; or the password contains a # or / " +
          "that has to be percent-encoded (%23, %2F). Resetting the database password to " +
          "an alphanumeric one avoids the encoding question entirely.",
      );
    }

    // Small on purpose: this pool serves one cron invocation at a time, and
    // Supabase's connection budget is shared with every other client.
    pool = new Pool({ connectionString, max: 2 });
  }

  return pool;
}

/**
 * Borrows a connection and lends `fn` a way to run transactions as the
 * authorized user.
 *
 * The role and the JWT claim are established *inside* each transaction, and
 * scoped to it. That placement is the whole point, and it is not obvious:
 *
 * A connection pooler in transaction mode — which is what Supabase hands out
 * for serverless clients, and what Vercel cron is — gives each transaction its
 * own backend connection rather than one per client. Anything set at session
 * level therefore lands on a backend that gets released immediately, and the
 * transaction that follows can run somewhere that never saw it. That backend is
 * still the superuser the pool dialled, which carries BYPASSRLS, so every
 * policy would be skipped — and nothing would fail. The writes would succeed,
 * the data would be correct, and the backstop would be silently gone.
 *
 * A transaction is guaranteed to run entirely on one backend in either pooling
 * mode, so scoping the settings to it makes this correct wherever it runs, and
 * removes the need to reason about which connection string was configured.
 *
 * It also means nothing has to be cleaned up: `set local` unwinds at commit or
 * rollback, so a pooled connection can never be handed on still wearing the
 * role. Previously a failed reset would have leaked it.
 */
export async function withAuthorizedSession<T>(
  pool: Pool,
  fn: (unitOfWork: UnitOfWork) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const claims = JSON.stringify({ email: ALLOWED_EMAIL, role: "authenticated" });

  try {
    const unitOfWork: UnitOfWork = async (body) => {
      await client.query("begin");

      try {
        // Claims before the role change: `authenticated` may set them too, but
        // this order is obviously correct rather than incidentally so.
        await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
        await client.query("set local role authenticated");

        const result = await body((text, params) => client.query(text, params));

        await client.query("commit");

        return result;
      } catch (cause) {
        await client.query("rollback").catch(() => {
          // The connection is already broken; the original error is the useful
          // one, and masking it with the rollback's would hide the cause.
        });

        throw cause;
      }
    };

    return await fn(unitOfWork);
  } finally {
    client.release();
  }
}

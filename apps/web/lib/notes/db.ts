/**
 * The Notes module's database connection — the one authorized writer every
 * server-side Notes write goes through.
 *
 * None of the Notes write paths has a signed-in user, and so none has a
 * Supabase session to borrow: a note is captured from a Telegram webhook
 * (server-to-server, no session), triaged from a background continuation or a
 * cron sweep, and corrected from a button tap. The easy answer would be the
 * service role, which bypasses RLS entirely; ben-os has none by design
 * (`apps/web/.env.example` warns against substituting one) and this deliberately
 * doesn't take it. Instead each transaction drops to the `authenticated` role
 * and presents the authorized user's email as a JWT claim, so `is_authorized()`
 * is evaluated on every statement — a Telegram-originated insert passes the
 * same RLS as a web write (ADR 0011 dec. 4).
 *
 * This mirrors `apps/web/lib/financials/db.ts` on purpose: the Financials cron
 * writer already solved this exact "privileged server writer, no session"
 * problem, and the Notes module reuses the pattern rather than inventing a
 * second answer. ADR 0011 dec. 4 prescribes a `lib/notes/db.ts` *analogue*
 * "modeled directly on" that file, so the parallel is a deliberate per-domain
 * copy, not an accident — the two modules stay siblings the way `notes/` and
 * `financials/` do throughout this app, rather than reaching across domains for
 * a shared helper.
 */

import { Pool } from "pg";

import { ALLOWED_EMAIL } from "@/lib/auth";

/**
 * The parts of `pg`'s result the Notes writes read: `rows`, and `rowCount` —
 * the latter is how an idempotent capture tells an inserted note from an
 * `insert … on conflict do nothing` no-op (ADR 0010 dec. 8) without adding a
 * `returning` to every call site. `null` when the driver reports no count.
 */
export type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

/**
 * A bare query function rather than a `pg.Pool`, so the caller decides what the
 * statements run against — a pooled connection in production, a per-test
 * connection in the suite. Both run the same SQL against a real Postgres with
 * RLS active.
 */
export type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * Runs one atomic piece of work as the authorized user and hands back its
 * result.
 *
 * The unit is a single transaction on a single connection: Postgres aborts the
 * whole transaction on the first failed statement, so isolating each unit keeps
 * one bad write from taking unrelated writes down with it.
 */
export type UnitOfWork = <T>(body: (query: QueryFn) => Promise<T>) => Promise<T>;

let pool: Pool | undefined;

/**
 * SSL is left to the connection string (`?sslmode=require` / `no-verify`) rather
 * than hardcoded, because the right answer differs between Supabase's custom CA
 * and a local test server, and only the URL knows which one it points at.
 */
export function notesPool(): Pool {
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
    // rejects a malformed string with a bare "Invalid URL", which says nothing
    // about which variable or why. The causes named below are the ones that
    // actually throw, checked rather than assumed: a leftover `[YOUR-PASSWORD]`
    // placeholder parses fine, and so does an unencoded `@` in the password (the
    // URL spec splits on the *last* `@`, so the host survives). What genuinely
    // breaks it is a `#` or `/` in the password, quotes around the value, or the
    // `psql '…'` line from Supabase's Connect dialog pasted whole.
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

    // Small on purpose: Supabase's connection budget is shared with every other
    // client, and the Notes write paths are short and bursty.
    pool = new Pool({ connectionString, max: 2 });
  }

  return pool;
}

/**
 * Borrows a connection and lends `fn` a way to run transactions as the
 * authorized user.
 *
 * The pool is a parameter rather than reached for internally so the same helper
 * can be driven against a per-test Postgres — the RLS this establishes has no
 * meaningful test without a real database to enforce it.
 *
 * The role and the JWT claim are established *inside* each transaction, and
 * scoped to it with `set local`. That placement is the whole point, and it is
 * not obvious:
 *
 * A connection pooler in transaction mode — what Supabase hands out for
 * serverless clients, and what a Vercel function is — gives each transaction its
 * own backend connection rather than one per client. Anything set at session
 * level therefore lands on a backend that gets released immediately, and the
 * transaction that follows can run somewhere that never saw it. That backend is
 * still the superuser the pool dialled, which carries BYPASSRLS, so every policy
 * would be skipped — and nothing would fail. The writes would succeed, the data
 * would be correct, and the backstop would be silently gone.
 *
 * A transaction is guaranteed to run entirely on one backend in either pooling
 * mode, so scoping the settings to it makes this correct wherever it runs. It
 * also means nothing has to be cleaned up: `set local` unwinds at commit or
 * rollback, so a pooled connection can never be handed on still wearing the role.
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

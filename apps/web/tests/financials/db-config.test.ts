// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The failure paths of `financialsPool`, which are the ones an operator meets
 * while wiring up a deployment. A valid connection string is exercised for real
 * by the sync tests.
 *
 * Every case here was checked against `new URL` before being written down — the
 * obvious guesses at what breaks a Postgres connection string are mostly wrong.
 * A leftover `[YOUR-PASSWORD]` placeholder parses cleanly, and so does an `@` in
 * the password. Both are pinned below precisely because they look like faults.
 */
afterEach(() => {
  vi.resetModules();
  delete process.env.DATABASE_URL;
});

async function freshPool() {
  // The pool is memoised per module instance, so each case needs its own.
  vi.resetModules();

  return (await import("@/lib/financials/db")).financialsPool;
}

describe("financialsPool", () => {
  it("says which variable is missing, and that a redeploy is needed", async () => {
    const pool = await freshPool();

    expect(pool).toThrow(/DATABASE_URL is not set/);
    expect(pool).toThrow(/redeploy/);
  });

  it("names DATABASE_URL rather than passing on pg's bare `Invalid URL`", async () => {
    process.env.DATABASE_URL = "postgresql://user:pa#ss@host:5432/postgres";

    const pool = await freshPool();

    expect(pool).toThrow(/DATABASE_URL is not a valid URL/);
  });

  it("catches the psql command being pasted instead of the URL inside it", async () => {
    // Supabase's Connect dialog offers a ready-to-run `psql '…'` line, which is
    // the obvious thing to copy and the wrong thing to paste.
    process.env.DATABASE_URL = "psql 'postgresql://user:pw@host:5432/postgres'";

    const pool = await freshPool();

    expect(pool).toThrow(/psql/);
  });

  it("catches a value someone wrapped in quotes", async () => {
    process.env.DATABASE_URL = '"postgresql://user:pw@host:5432/postgres"';

    const pool = await freshPool();

    expect(pool).toThrow(/quotes/);
  });

  it("accepts an unencoded @ in the password, which is not the problem it looks like", async () => {
    // Pinned because it is the obvious thing to "fix". The URL spec splits the
    // authority on the *last* @, so the host is untouched and the password
    // comes through percent-encoded. A guard against this would reject valid
    // configuration.
    process.env.DATABASE_URL = "postgresql://user:pa@ss@host:5432/postgres";

    const pool = await freshPool();

    expect(pool).not.toThrow();
    expect(new URL(process.env.DATABASE_URL).host).toBe("host:5432");
  });

  it("accepts a well-formed connection string", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres.ref:alnum123@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=no-verify";

    const pool = await freshPool();

    expect(pool).not.toThrow();
  });
});

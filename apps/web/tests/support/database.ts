import { Pool } from "pg";
import { inject } from "vitest";

import type { QueryFn } from "@/lib/financials/store";

/**
 * Helpers for talking to the run-wide Postgres that `postgres-global.ts` starts.
 *
 * Every query here goes through a role and JWT claim, never as the superuser the
 * pool connects as — otherwise RLS would be bypassed and the tests would prove
 * the policies exist rather than that they work.
 */

let pool: Pool | undefined;

export function testPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: inject("financialsDatabaseUrl"), max: 4 });
  }

  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Runs `body` as `authenticated`, presenting `email` as the JWT claim.
 *
 * Mirrors what `withAuthorizedSession` does in production, but takes the email
 * as an argument — proving RLS is switched on requires running as somebody the
 * policy rejects, which the production helper can't express by design.
 */
export async function asUser<T>(email: string, body: (query: QueryFn) => Promise<T>): Promise<T> {
  const client = await testPool().connect();

  try {
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ email, role: "authenticated" }),
    ]);
    await client.query("set role authenticated");

    return await body((text, params) => client.query(text, params));
  } finally {
    await client.query("discard all").catch(() => {});
    client.release();
  }
}

/** Superuser access, for arranging and inspecting state around what RLS guards. */
export async function asSuperuser<T>(body: (query: QueryFn) => Promise<T>): Promise<T> {
  const client = await testPool().connect();

  try {
    return await body((text, params) => client.query(text, params));
  } finally {
    client.release();
  }
}

const FINANCIALS_TABLES = [
  "public.financials_transaction",
  "public.financials_balance_snapshot",
  "public.financials_account",
  "public.financials_connection",
  "public.financials_category",
];

/**
 * Truncate rather than roll back a wrapping transaction: the sync job runs its
 * own transactions, and nesting those inside a test-owned one would quietly
 * convert them to no-ops — hiding the very commit boundaries under test.
 */
export async function resetFinancials(): Promise<void> {
  await asSuperuser((query) =>
    query(`truncate ${FINANCIALS_TABLES.join(", ")} restart identity cascade`),
  );
}

export async function countRows(table: string): Promise<number> {
  const { rows } = await asSuperuser((query) => query(`select count(*)::int as n from ${table}`));

  return rows[0].n as number;
}

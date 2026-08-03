// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { withAuthorizedSession } from "@/lib/financials/db";
import { createSimpleFinClient } from "@/lib/financials/simplefin";
import { syncSimpleFin } from "@/lib/financials/sync";

import {
  asSuperuser,
  closeTestPool,
  countRows,
  resetFinancials,
  testPool,
} from "../support/database";
import {
  account,
  accountSet,
  CHASE_CONN,
  stubFetch,
  TEST_ACCESS_URL,
  transaction,
} from "../support/simplefin";

/**
 * The guards from `20260802205533_financials_destructive_guards.sql`.
 *
 * Worth testing rather than trusting: a tripwire nobody has tripped on purpose
 * is indistinguishable from one that was never armed. These run against the
 * same migrations the hosted project has, so a guard that stopped firing —
 * because a later migration recreated a table without reattaching its triggers,
 * say — fails here rather than silently on the day it was needed.
 */

const NOW = new Date("2026-08-01T09:17:00Z");

async function seed(transactionCount: number) {
  const transactions = Array.from({ length: transactionCount }, (_, i) =>
    transaction({ id: `txn-${i}`, pending: false }),
  );
  const client = createSimpleFinClient(TEST_ACCESS_URL, {
    fetch: stubFetch([
      accountSet({ connections: [CHASE_CONN], accounts: [account({ transactions })] }),
    ]),
  });

  await withAuthorizedSession(testPool(), (unitOfWork) =>
    syncSimpleFin({ client, unitOfWork, now: NOW }),
  );
}

beforeEach(resetFinancials);
afterAll(closeTestPool);

describe("destructive guards", () => {
  it("refuses to truncate a financials table", async () => {
    await seed(1);

    await expect(
      asSuperuser((query) => query("truncate public.financials_transaction")),
    ).rejects.toThrow(/Refusing to truncate/);

    expect(await countRows("public.financials_transaction")).toBe(1);
  });

  it("arms every financials table, including the ones added after the guards", async () => {
    // The guards are per-table triggers attached by a migration, so a table
    // landing later is a table with no tripwire unless its own migration
    // remembers to attach them. Holdings snapshots are as unrecoverable as
    // transactions — SnapTrade serves the current reading, not past ones.
    for (const table of ["public.financials_holding", "public.financials_security"]) {
      await expect(asSuperuser((query) => query(`truncate ${table} cascade`))).rejects.toThrow(
        /Refusing to truncate/,
      );
    }
  });

  it("refuses to drop a financials table", async () => {
    await expect(
      asSuperuser((query) => query("drop table public.financials_balance_snapshot")),
    ).rejects.toThrow(/Refusing to drop/);

    // The event trigger fires after the drop but inside its transaction, so the
    // table has to still be there afterwards for the guard to mean anything.
    const { rows } = await asSuperuser((query) =>
      query("select to_regclass('public.financials_balance_snapshot') is not null as still_there"),
    );

    expect(rows[0].still_there).toBe(true);
  });

  it("refuses a delete large enough to be a mistake", async () => {
    await seed(101);

    await expect(
      asSuperuser((query) => query("delete from public.financials_transaction")),
    ).rejects.toThrow(/Refusing to delete 101 rows/);

    expect(await countRows("public.financials_transaction")).toBe(101);
  });

  it("allows a delete small enough to be the sync pruning", async () => {
    // The guard must not break the job it exists to protect: pruning removes a
    // handful of pending rows, and would be worthless if it tripped a tripwire.
    await seed(5);

    await asSuperuser((query) => query("delete from public.financials_transaction"));

    expect(await countRows("public.financials_transaction")).toBe(0);
  });

  it("lets a deliberate transaction opt out", async () => {
    await seed(1);

    await asSuperuser(async (query) => {
      await query("begin");
      await query("set local ben_os.allow_bulk_delete = 'on'");
      await query("truncate public.financials_transaction");
      await query("commit");
    });

    expect(await countRows("public.financials_transaction")).toBe(0);
  });

  it("puts the guard back for the next transaction", async () => {
    // `set local` is what makes the opt-out safe. If it leaked to the session,
    // one maintenance statement would disarm everything after it.
    await seed(1);

    await asSuperuser(async (query) => {
      await query("begin");
      await query("set local ben_os.allow_bulk_delete = 'on'");
      await query("commit");
    });

    await expect(
      asSuperuser((query) => query("truncate public.financials_transaction")),
    ).rejects.toThrow(/Refusing to truncate/);
  });
});

// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ALLOWED_EMAIL } from "@/lib/auth";
import { withAuthorizedSession } from "@/lib/financials/db";
import { createSimpleFinClient, type SimpleFinAccountSet } from "@/lib/financials/simplefin";
import { syncSimpleFin, type SyncResult } from "@/lib/financials/sync";

import {
  asSuperuser,
  asUser,
  closeTestPool,
  countRows,
  resetFinancials,
  testPool,
} from "../support/database";
import {
  account,
  accountSet,
  CHASE_CONN,
  epoch,
  FIDELITY_CONN,
  stubFetch,
  TEST_ACCESS_URL,
  transaction,
} from "../support/simplefin";

/**
 * The sync job, end to end, against a real Postgres with RLS switched on.
 *
 * Every run below goes through `withAuthorizedSession`, the same helper the cron
 * route uses — which means the job holds no more privilege here than it does in
 * production, and a policy that rejected it would fail these tests rather than
 * being quietly bypassed by a service-role connection.
 */

const NOW = new Date("2026-08-01T09:17:00Z");

async function runSync(
  responses: SimpleFinAccountSet[],
  { now = NOW }: { now?: Date } = {},
): Promise<SyncResult> {
  const client = createSimpleFinClient(TEST_ACCESS_URL, { fetch: stubFetch(responses) });

  return withAuthorizedSession(testPool(), (unitOfWork) =>
    syncSimpleFin({ client, unitOfWork, now }),
  );
}

/** Two polls, five days apart, the way the schedule actually drives the job. */
async function runTwoPolls(first: SimpleFinAccountSet, second: SimpleFinAccountSet) {
  const one = await runSync([first], { now: NOW });
  const two = await runSync([second], { now: new Date(NOW.getTime() + 60_000) });

  return { one, two };
}

const chaseOnly = (transactions = [transaction()]) =>
  accountSet({
    connections: [CHASE_CONN],
    accounts: [account({ transactions })],
  });

beforeEach(resetFinancials);
afterAll(closeTestPool);

describe("first sync", () => {
  it("writes the connection, account, a balance snapshot and its transactions", async () => {
    const result = await runSync([chaseOnly()]);

    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      providerConnId: CHASE_CONN.conn_id,
      name: "Chase",
      status: "synced",
      accounts: 1,
      transactionsUpserted: 1,
      snapshotsWritten: 1,
    });

    const { rows } = await asSuperuser((query) =>
      query(`select c.provider, c.provider_conn_id, c.org_id, c.extra,
                    a.provider_account_id, a.name, a.currency, a.balance,
                    a.available_balance, a.kind, a.status
               from public.financials_account a
               join public.financials_connection c on c.id = a.connection_id`),
    );

    expect(rows[0]).toMatchObject({
      provider: "simplefin",
      provider_conn_id: CHASE_CONN.conn_id,
      org_id: CHASE_CONN.org_id,
      provider_account_id: "acct-chase-checking",
      name: "Chase Checking",
      currency: "USD",
      balance: "1500.00",
      available_balance: "1450.00",
      // Both user-owned; sync only ever supplies the default.
      kind: "depository",
      status: "active",
    });
    expect(rows[0].extra).toMatchObject({ sfin_url: CHASE_CONN.sfin_url });
  });

  it("stores amounts exactly, as numeric rather than float", async () => {
    await runSync([chaseOnly([transaction({ amount: "-1234567.89" })])]);

    const { rows } = await asSuperuser((query) =>
      query("select amount from public.financials_transaction"),
    );

    expect(rows[0].amount).toBe("-1234567.89");
  });

  it("keeps a non-ISO currency, which SimpleFIN represents as a URL", async () => {
    await runSync([
      accountSet({
        connections: [CHASE_CONN],
        accounts: [account({ currency: "https://mycurrency.test/points", transactions: [] })],
      }),
    ]);

    const { rows } = await asSuperuser((query) =>
      query("select currency from public.financials_account"),
    );

    expect(rows[0].currency).toBe("https://mycurrency.test/points");
  });
});

describe("overlapping windows", () => {
  it("upserts by (account_id, provider_transaction_id) rather than duplicating", async () => {
    const { two } = await runTwoPolls(chaseOnly(), chaseOnly());

    expect(two.connections[0].transactionsUpserted).toBe(1);
    expect(await countRows("public.financials_transaction")).toBe(1);
    expect(await countRows("public.financials_account")).toBe(1);
    expect(await countRows("public.financials_connection")).toBe(1);
  });

  it("updates a transaction whose details changed between polls", async () => {
    await runTwoPolls(
      chaseOnly([transaction({ description: "PENDING COFFEE", amount: "-40.00", pending: true })]),
      chaseOnly([
        transaction({ description: "COFFEE SHOP #12", amount: "-42.50", pending: false }),
      ]),
    );

    const { rows } = await asSuperuser((query) =>
      query("select description, amount, pending from public.financials_transaction"),
    );

    expect(rows).toEqual([{ description: "COFFEE SHOP #12", amount: "-42.50", pending: false }]);
  });

  it("does not resurrect an account the user marked closed", async () => {
    // ADR 0002 keeps a closed account's row so its history survives. That is
    // only true if the next poll — which still reports the account — leaves the
    // status alone.
    await runSync([chaseOnly()]);

    await asUser(ALLOWED_EMAIL, (query) =>
      query("update public.financials_account set status = 'closed', kind = 'investment'"),
    );

    await runSync([chaseOnly()], { now: new Date(NOW.getTime() + 60_000) });

    const { rows } = await asSuperuser((query) =>
      query("select status, kind from public.financials_account"),
    );

    expect(rows[0]).toEqual({ status: "closed", kind: "investment" });
  });

  it("leaves a category the user assigned alone", async () => {
    await runSync([chaseOnly()]);

    const categoryId = await asUser(ALLOWED_EMAIL, async (query) => {
      const { rows } = await query(
        "insert into public.financials_category (name) values ('Coffee') returning id",
      );

      await query("update public.financials_transaction set category_id = $1", [rows[0].id]);

      return rows[0].id;
    });

    await runSync([chaseOnly()], { now: new Date(NOW.getTime() + 60_000) });

    const { rows } = await asSuperuser((query) =>
      query("select category_id from public.financials_transaction"),
    );

    expect(rows[0].category_id).toBe(categoryId);
  });
});

describe("balance snapshots", () => {
  it("writes one per account per poll, even when no transaction moved", async () => {
    await runTwoPolls(chaseOnly(), chaseOnly());

    expect(await countRows("public.financials_balance_snapshot")).toBe(2);
  });

  it("records the balance as reported, with its own balance-date", async () => {
    await runSync([
      accountSet({
        connections: [CHASE_CONN],
        accounts: [
          account({
            balance: "1500.00",
            "available-balance": "1450.00",
            "balance-date": epoch("2026-07-31T23:00:00Z"),
          }),
        ],
      }),
    ]);

    const { rows } = await asSuperuser((query) =>
      query(
        "select balance, available_balance, balance_date from public.financials_balance_snapshot",
      ),
    );

    expect(rows[0]).toEqual({
      balance: "1500.00",
      available_balance: "1450.00",
      balance_date: new Date("2026-07-31T23:00:00Z"),
    });
  });
});

describe("pending transactions that disappear", () => {
  it("prunes one the provider stopped reporting, so it can't double-count", async () => {
    // The classic shape: a pending charge re-posts under a different id.
    await runTwoPolls(
      chaseOnly([transaction({ id: "txn-pending", pending: true, amount: "-42.50" })]),
      chaseOnly([transaction({ id: "txn-posted", pending: false, amount: "-42.50" })]),
    );

    const { rows } = await asSuperuser((query) =>
      query("select provider_transaction_id from public.financials_transaction"),
    );

    expect(rows).toEqual([{ provider_transaction_id: "txn-posted" }]);
  });

  it("reports what it pruned", async () => {
    const { two } = await runTwoPolls(
      chaseOnly([transaction({ id: "txn-pending", pending: true })]),
      chaseOnly([transaction({ id: "txn-posted", pending: false })]),
    );

    expect(two.connections[0].pendingPruned).toBe(1);
  });

  it("leaves a posted transaction alone when it drops out of a poll", async () => {
    // Absence is only evidence for pending rows. A posted one that stops being
    // reported is far more likely a provider hiccup than a reversal.
    await runTwoPolls(
      chaseOnly([transaction({ id: "txn-posted", pending: false })]),
      chaseOnly([]),
    );

    expect(await countRows("public.financials_transaction")).toBe(1);
  });

  it("does not prune when the account came back with no transaction feed at all", async () => {
    // `transactions` omitted is the provider declining to answer — a degraded
    // account alongside an act.* error, or a balances-only response. Treating
    // that as "nothing here" would delete every pending row the account has.
    const withFeed = chaseOnly([transaction({ id: "txn-pending", pending: true })]);
    const withoutFeed = accountSet({
      connections: [CHASE_CONN],
      accounts: [account({ transactions: undefined })],
    });

    const { two } = await runTwoPolls(withFeed, withoutFeed);

    expect(two.connections[0].pendingPruned).toBe(0);
    expect(await countRows("public.financials_transaction")).toBe(1);
    // The balance is still an answer, so the snapshot is still written.
    expect(await countRows("public.financials_balance_snapshot")).toBe(2);
  });

  it("does prune when the account came back with an empty feed", async () => {
    // An empty array is the provider answering "nothing in this window", which
    // is exactly the evidence an omitted feed isn't.
    const { two } = await runTwoPolls(
      chaseOnly([transaction({ id: "txn-pending", pending: true })]),
      chaseOnly([]),
    );

    expect(two.connections[0].pendingPruned).toBe(1);
    expect(await countRows("public.financials_transaction")).toBe(0);
  });

  it("leaves a pending transaction older than the fetched window alone", async () => {
    // Outside the window it was never looked for, so its absence says nothing.
    const stale = transaction({
      id: "txn-old-pending",
      pending: true,
      posted: epoch("2026-06-01T00:00:00Z"),
    });

    await runTwoPolls(chaseOnly([stale]), chaseOnly([]));

    expect(await countRows("public.financials_transaction")).toBe(1);
  });
});

describe("the first poll", () => {
  it("reaches back the full 90 days, so history doesn't start five days ago", async () => {
    const fetch = stubFetch([chaseOnly()]);
    const client = createSimpleFinClient(TEST_ACCESS_URL, { fetch });

    await withAuthorizedSession(testPool(), (unitOfWork) =>
      syncSimpleFin({ client, unitOfWork, now: NOW }),
    );

    const startDate = new URL(fetch.calls[0]).searchParams.get("start-date");

    expect(Number(startDate)).toBe(Math.floor(new Date("2026-05-03T09:17:00Z").getTime() / 1000));
  });

  it("falls back to the 5-day overlap once there is history to overlap with", async () => {
    await runSync([chaseOnly()]);

    const fetch = stubFetch([chaseOnly()]);
    const client = createSimpleFinClient(TEST_ACCESS_URL, { fetch });

    await withAuthorizedSession(testPool(), (unitOfWork) =>
      syncSimpleFin({ client, unitOfWork, now: NOW }),
    );

    const startDate = new URL(fetch.calls[0]).searchParams.get("start-date");

    expect(Number(startDate)).toBe(Math.floor(new Date("2026-07-27T09:17:00Z").getTime() / 1000));
  });
});

describe("per-connection error isolation", () => {
  it("attributes an errlist entry to the connection it names, not the whole poll", async () => {
    const result = await runSync([
      accountSet({
        connections: [CHASE_CONN, FIDELITY_CONN],
        accounts: [account({ transactions: [transaction()] })],
        errlist: [
          {
            code: "con.disconnected",
            msg: "Fidelity needs re-authentication",
            conn_id: "conn-fidelity",
          },
        ],
      }),
    ]);

    const chase = result.connections.find((c) => c.providerConnId === CHASE_CONN.conn_id);
    const fidelity = result.connections.find((c) => c.providerConnId === FIDELITY_CONN.conn_id);

    expect(chase).toMatchObject({ status: "synced", accounts: 1, errors: [] });
    expect(fidelity?.errors).toHaveLength(1);
    expect(result.generalErrors).toEqual([]);
  });

  it("attributes an account-scoped error through the account's connection", async () => {
    const result = await runSync([
      accountSet({
        connections: [CHASE_CONN],
        accounts: [account()],
        errlist: [
          { code: "act.needs-attention", msg: "Stale balance", account_id: "acct-chase-checking" },
        ],
      }),
    ]);

    expect(result.connections[0].errors).toHaveLength(1);
    expect(result.generalErrors).toEqual([]);
  });

  it("keeps a poll-wide error out of any one connection's ledger", async () => {
    const result = await runSync([
      accountSet({
        connections: [CHASE_CONN],
        accounts: [account()],
        errlist: [{ code: "gen.quota", msg: "Approaching the daily request limit" }],
      }),
    ]);

    expect(result.generalErrors).toHaveLength(1);
    expect(result.connections[0].errors).toEqual([]);
  });

  it("still syncs the healthy connection when another one's write fails", async () => {
    // A non-numeric balance is rejected by the numeric column — a real,
    // database-level failure, which is the case that matters: Postgres aborts a
    // transaction on the first bad statement, so without a transaction per
    // connection this would take Chase's writes down with Fidelity's.
    const result = await runSync([
      accountSet({
        connections: [CHASE_CONN, FIDELITY_CONN],
        accounts: [
          account({ transactions: [transaction()] }),
          account({
            id: "acct-fidelity-brokerage",
            name: "Fidelity Brokerage",
            conn_id: FIDELITY_CONN.conn_id,
            balance: "not-a-number",
            transactions: [],
          }),
        ],
      }),
    ]);

    const chase = result.connections.find((c) => c.providerConnId === CHASE_CONN.conn_id);
    const fidelity = result.connections.find((c) => c.providerConnId === FIDELITY_CONN.conn_id);

    expect(chase?.status).toBe("synced");
    expect(fidelity?.status).toBe("failed");
    expect(fidelity?.failure).toMatch(/numeric/i);

    // Chase's rows survived, and Fidelity's half-written ones rolled back.
    const { rows } = await asSuperuser((query) =>
      query("select provider_conn_id from public.financials_connection"),
    );

    expect(rows).toEqual([{ provider_conn_id: CHASE_CONN.conn_id }]);
    expect(await countRows("public.financials_transaction")).toBe(1);
  });

  it("records a connection that reported no accounts at all", async () => {
    const result = await runSync([
      accountSet({
        connections: [CHASE_CONN, FIDELITY_CONN],
        accounts: [account()],
        errlist: [{ code: "con.error", msg: "Login failed", conn_id: FIDELITY_CONN.conn_id }],
      }),
    ]);

    const fidelity = result.connections.find((c) => c.providerConnId === FIDELITY_CONN.conn_id);

    expect(fidelity).toMatchObject({ status: "synced", accounts: 0, snapshotsWritten: 0 });
    // The row exists so the dashboard can show the institution as broken rather
    // than as absent.
    expect(await countRows("public.financials_connection")).toBe(2);
  });
});

describe("the sync job's own database session", () => {
  it("runs every unit of work as the authorized user, not as the superuser it dialled", async () => {
    const seen = await withAuthorizedSession(testPool(), (unitOfWork) =>
      unitOfWork(async (query) => {
        const { rows } = await query(
          "select current_user::text as role, public.is_authorized() as authorized",
        );

        return rows[0];
      }),
    );

    expect(seen).toEqual({ role: "authenticated", authorized: true });
  });

  it("re-establishes them for each unit of work rather than once per session", async () => {
    // The settings are transaction-scoped, so the second unit of work is only
    // authorized if it sets them up itself. This is what makes the job correct
    // under a pooler that gives each transaction a different backend — routing
    // no test here can reproduce, but the per-transaction setup it needs is
    // exactly what this asserts.
    const seen = await withAuthorizedSession(testPool(), async (unitOfWork) => {
      const first = await unitOfWork(async (query) => {
        const { rows } = await query("select current_user::text as role");

        return rows[0].role;
      });

      const second = await unitOfWork(async (query) => {
        const { rows } = await query("select current_user::text as role");

        return rows[0].role;
      });

      return [first, second];
    });

    expect(seen).toEqual(["authenticated", "authenticated"]);
  });
});

describe("row level security", () => {
  it("hides every financials table from a caller who is not the authorized user", async () => {
    await runSync([chaseOnly()]);

    const visible = await asUser("someone-else@example.test", async (query) => {
      const { rows } = await query(`select
          (select count(*) from public.financials_connection) as connections,
          (select count(*) from public.financials_account) as accounts,
          (select count(*) from public.financials_transaction) as transactions,
          (select count(*) from public.financials_balance_snapshot) as snapshots`);

      return rows[0];
    });

    expect(visible).toEqual({ connections: "0", accounts: "0", transactions: "0", snapshots: "0" });
  });

  it("refuses a write from a caller who is not the authorized user", async () => {
    await expect(
      asUser("someone-else@example.test", (query) =>
        query(
          `insert into public.financials_connection (provider, provider_conn_id, name)
           values ('simplefin', 'sneaky', 'Sneaky')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("shows the authorized user everything the sync wrote", async () => {
    await runSync([chaseOnly()]);

    const { rows } = await asUser(ALLOWED_EMAIL, (query) =>
      query("select count(*)::int as n from public.financials_account"),
    );

    expect(rows[0].n).toBe(1);
  });
});

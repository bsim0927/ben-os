// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { withAuthorizedSession } from "@/lib/financials/db";
import { syncSnapTradeHoldings, type HoldingsSyncResult } from "@/lib/financials/holdings-sync";
import { createSnapTradeClient, type SnapTradeHoldings } from "@/lib/financials/snaptrade";
import { createFinancialsStore } from "@/lib/financials/store";

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
  FIDELITY_INDIVIDUAL,
  FIDELITY_ROTH,
  holdings,
  position,
  stubHoldingsByAccount,
  TEST_AUTHORIZATION_ID,
  TEST_CREDENTIALS,
} from "../support/snaptrade";

/**
 * The holdings sync, end to end, against a real Postgres with RLS switched on.
 *
 * The thing most worth proving here is what the job *doesn't* do. Fidelity is
 * already an account in this database, synced from SimpleFIN; a holdings sync
 * that also wrote accounts or balance snapshots would count Fidelity twice in
 * net worth. So several of these assert absence, and they are the point rather
 * than padding.
 */

const NOW = new Date("2026-08-02T11:37:00Z");
const AS_OF = "2026-08-02T06:30:00Z";

/** Stands in for what the SimpleFIN sync has already put there. */
async function arrangeSimpleFinAccounts(): Promise<{ individual: string; roth: string }> {
  return asSuperuser(async (query) => {
    const { rows: connections } = await query(
      `insert into public.financials_connection (provider, provider_conn_id, name)
       values ('simplefin', 'MX-MBR-fidelity', 'Fidelity Investments') returning id`,
    );
    const connectionId = connections[0].id as string;

    const insertAccount = async (providerAccountId: string, name: string, balance: string) => {
      const { rows } = await query(
        `insert into public.financials_account
           (connection_id, provider_account_id, name, kind, currency, balance)
         values ($1, $2, $3, 'investment', 'USD', $4) returning id`,
        [connectionId, providerAccountId, name, balance],
      );

      return rows[0].id as string;
    };

    return {
      individual: await insertAccount("ACT-individual", "Individual (5008)", "5334.03"),
      roth: await insertAccount("ACT-roth", "ROTH IRA (3715)", "608.86"),
    };
  });
}

async function link(accountLinks: Record<string, string>): Promise<void> {
  await withAuthorizedSession(testPool(), (unitOfWork) =>
    unitOfWork((query) =>
      createFinancialsStore(query).upsertSnapTradeConnection({
        authorizationId: TEST_AUTHORIZATION_ID,
        name: "Fidelity",
        accountLinks,
      }),
    ),
  );
}

async function runSync(
  byAccount: Record<string, SnapTradeHoldings>,
  { now = NOW }: { now?: Date } = {},
): Promise<HoldingsSyncResult> {
  const client = createSnapTradeClient(TEST_CREDENTIALS, {
    fetch: stubHoldingsByAccount(byAccount),
    now: () => now,
  });

  return withAuthorizedSession(testPool(), (unitOfWork) =>
    syncSnapTradeHoldings({ client, unitOfWork, now }),
  );
}

beforeEach(resetFinancials);
afterAll(closeTestPool);

describe("first holdings sync", () => {
  it("writes a security and a holding against the account already in the database", async () => {
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });

    const result = await runSync({ [FIDELITY_INDIVIDUAL]: holdings() });

    expect(result.status).toBe("synced");
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      snapTradeAccountId: FIDELITY_INDIVIDUAL,
      accountId: individual,
      status: "synced",
      positions: 1,
      holdingsInserted: 1,
      asOf: new Date(AS_OF).toISOString(),
    });

    const { rows } = await asSuperuser((query) =>
      query(`select s.symbol, s.name, s.security_type, s.extra,
                    h.account_id, h.quantity, h.average_cost_basis, h.market_price,
                    h.currency, h.tax_lots, h.extra as holding_extra, h.as_of
               from public.financials_holding h
               join public.financials_security s on s.id = h.security_id`),
    );

    expect(rows[0]).toMatchObject({
      symbol: "VTI",
      name: "Vanguard Total Stock Market ETF",
      security_type: "etf",
      account_id: individual,
      quantity: "12.5",
      average_cost_basis: "280.78",
      market_price: "291.44",
      currency: "USD",
      // Absent from the fixture, and absent is not an empty array: SnapTrade
      // exposes lot detail inconsistently (ADR 0004 decision 4).
      tax_lots: null,
    });
    expect(new Date(rows[0].as_of as string).toISOString()).toBe(new Date(AS_OF).toISOString());
    // The raw provider code is kept even though it mapped cleanly, so a mapping
    // this app gets wrong later is still recoverable from the row.
    expect(rows[0].extra).toMatchObject({ snaptrade_type_code: "et" });
  });

  it("creates no accounts and no balance snapshots — Fidelity is already both", async () => {
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });

    await runSync({ [FIDELITY_INDIVIDUAL]: holdings() });

    // Two, from the arrangement — SnapTrade added none. A third would be the
    // same Fidelity account counted twice in net worth.
    expect(await countRows("public.financials_account")).toBe(2);
    expect(await countRows("public.financials_balance_snapshot")).toBe(0);
    expect(await countRows("public.financials_connection")).toBe(2);
  });

  it("stores fractional quantities exactly, as numeric rather than float", async () => {
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });

    await runSync({
      [FIDELITY_INDIVIDUAL]: holdings({ positions: [position({ units: 0.00123456 })] }),
    });

    const { rows } = await asSuperuser((query) =>
      query("select quantity from public.financials_holding"),
    );

    expect(rows[0].quantity).toBe("0.00123456");
  });
});

describe("repeat syncs", () => {
  it("writes nothing the second time when the provider's reading has not moved", async () => {
    // The idempotency ADR 0004 decision 5 asks for. `as_of` comes from
    // SnapTrade's own last successful sync, so a retry against an unchanged
    // Daily-plan reading lands on the same key and does nothing.
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });

    await runSync({ [FIDELITY_INDIVIDUAL]: holdings() });
    const second = await runSync(
      { [FIDELITY_INDIVIDUAL]: holdings() },
      {
        now: new Date(NOW.getTime() + 60_000),
      },
    );

    expect(second.accounts[0].holdingsInserted).toBe(0);
    expect(await countRows("public.financials_holding")).toBe(1);
    expect(await countRows("public.financials_security")).toBe(1);
  });

  it("appends a new row when the provider has re-read the account", async () => {
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });

    await runSync({ [FIDELITY_INDIVIDUAL]: holdings() });
    await runSync({
      [FIDELITY_INDIVIDUAL]: holdings({
        account: account({
          sync_status: { holdings: { last_successful_sync: "2026-08-03T06:30:00Z" } },
        }),
        positions: [position({ units: 14, price: 295.1 })],
      }),
    });

    // Appended, not updated: holdings are snapshots, and the first reading is
    // still true of the day it was taken.
    const { rows } = await asSuperuser((query) =>
      query("select quantity, as_of from public.financials_holding order by as_of"),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.quantity)).toEqual(["12.5", "14"]);
  });

  it("reuses one security row across accounts holding the same thing", async () => {
    const { individual, roth } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual, [FIDELITY_ROTH]: roth });

    await runSync({
      [FIDELITY_INDIVIDUAL]: holdings(),
      [FIDELITY_ROTH]: holdings({
        account: account({ id: FIDELITY_ROTH }),
        positions: [position({ units: 3 })],
      }),
    });

    expect(await countRows("public.financials_security")).toBe(1);
    expect(await countRows("public.financials_holding")).toBe(2);
  });
});

describe("partial failure", () => {
  it("keeps one account's holdings when the other's fetch fails", async () => {
    const { individual, roth } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual, [FIDELITY_ROTH]: roth });

    // The Roth has no fixture, so the stub answers 404 — one account broken is
    // the normal case, and it must not cost the other its sync.
    const result = await runSync({ [FIDELITY_INDIVIDUAL]: holdings() });

    const byAccount = Object.fromEntries(
      result.accounts.map((row) => [row.snapTradeAccountId, row]),
    );

    expect(byAccount[FIDELITY_INDIVIDUAL].status).toBe("synced");
    expect(byAccount[FIDELITY_ROTH].status).toBe("failed");
    expect(byAccount[FIDELITY_ROTH].failure).toMatch(/404/);
    expect(await countRows("public.financials_holding")).toBe(1);
  });

  it("skips a position with no ticker rather than failing the account", async () => {
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });

    const result = await runSync({
      [FIDELITY_INDIVIDUAL]: holdings({
        positions: [position(), position({ symbol: null }), position({ units: null })],
      }),
    });

    expect(result.accounts[0]).toMatchObject({ positions: 3, holdingsInserted: 1, skipped: 2 });
    expect(await countRows("public.financials_holding")).toBe(1);
  });
});

describe("before anything is linked", () => {
  it("reports not-linked rather than failing, and writes nothing", async () => {
    await arrangeSimpleFinAccounts();

    const result = await runSync({});

    expect(result.status).toBe("not-linked");
    expect(result.accounts).toEqual([]);
    expect(await countRows("public.financials_holding")).toBe(0);
  });

  it("reports not-linked when the connection exists but no account is mapped to it", async () => {
    await arrangeSimpleFinAccounts();
    await link({});

    const result = await runSync({});

    expect(result.status).toBe("not-linked");
  });
});

describe("RLS", () => {
  it("admits the authorized user and rejects everyone else", async () => {
    const { individual } = await arrangeSimpleFinAccounts();
    await link({ [FIDELITY_INDIVIDUAL]: individual });
    await runSync({ [FIDELITY_INDIVIDUAL]: holdings() });

    const { rows: mine } = await asUser("bimmons927@gmail.com", (query) =>
      query("select id from public.financials_holding"),
    );
    const { rows: theirs } = await asUser("someone@else.test", (query) =>
      query("select id from public.financials_holding"),
    );

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe("schema", () => {
  it("leaves financials_holding without an updated_at trigger", async () => {
    // ADR 0004 decision 6, asserted rather than trusted: rows are insert-only,
    // so a BEFORE UPDATE trigger would never fire and `created_at` already says
    // everything it could.
    const { rows } = await asSuperuser((query) =>
      query(`select tgname from pg_trigger
              where tgrelid = 'public.financials_holding'::regclass
                and not tgisinternal`),
    );

    expect(rows.map((row) => row.tgname)).not.toContain("financials_holding_set_updated_at");
  });
});

// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject, vi } from "vitest";

const { createClient, createSnapTradeClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
  createSnapTradeClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/financials/snaptrade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/financials/snaptrade")>()),
  createSnapTradeClient,
}));

// Set before the route (and the pool it memoises) is ever reached, so the link
// route's writes land in the run's real Postgres rather than a stub. This route
// is where `kind = 'investment'` and the stored `authorizationId` come from, and
// both are only meaningful as rows.
process.env.DATABASE_URL = inject("financialsDatabaseUrl");

import { ALLOWED_EMAIL } from "@/lib/auth";
import { financialsPool } from "@/lib/financials/db";
import { GET, POST } from "@/app/api/financials/snaptrade/link/route";
import { POST as PORTAL } from "@/app/api/financials/snaptrade/portal/route";

import { asSuperuser, closeTestPool, resetFinancials } from "../support/database";
import {
  account,
  FIDELITY_INDIVIDUAL,
  FIDELITY_ROTH,
  TEST_AUTHORIZATION_ID,
} from "../support/snaptrade";

function signedInAs(email: string | null) {
  createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: email === null ? null : { email } } }) },
  });
}

function linkRequest(body: unknown): Request {
  return new Request("https://ben-os.test/api/financials/snaptrade/link", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function arrangeAccounts(): Promise<{ individual: string; roth: string }> {
  return asSuperuser(async (query) => {
    const { rows: connections } = await query(
      `insert into public.financials_connection (provider, provider_conn_id, name)
       values ('simplefin', 'MX-MBR-fidelity', 'Fidelity Investments') returning id`,
    );

    const insert = async (providerAccountId: string, name: string) => {
      const { rows } = await query(
        `insert into public.financials_account
           (connection_id, provider_account_id, name, currency, balance)
         values ($1, $2, $3, 'USD', 0) returning id`,
        [connections[0].id, providerAccountId, name],
      );

      return rows[0].id as string;
    };

    return {
      // Deliberately left at the `depository` default, which is what a
      // SimpleFIN-synced brokerage account actually starts as.
      individual: await insert("ACT-individual", "Individual (5008)"),
      roth: await insert("ACT-roth", "ROTH IRA (3715)"),
    };
  });
}

beforeAll(() => {
  process.env.SNAPTRADE_CLIENT_ID = "BEN-OS-TEST";
  process.env.SNAPTRADE_CONSUMER_KEY = "test-consumer-key";
});

beforeEach(async () => {
  vi.clearAllMocks();
  signedInAs(ALLOWED_EMAIL);
  createSnapTradeClient.mockReturnValue({
    listAccounts: async () => [account(), account({ id: FIDELITY_ROTH, name: "ROTH IRA" })],
    connectionPortalUrl: async () => "https://app.snaptrade.test/portal?token=abc",
    fetchHoldings: async () => ({ positions: [] }),
  });
  await resetFinancials();
});

afterAll(async () => {
  await financialsPool().end();
  await closeTestPool();
});

describe("the Connection Portal route", () => {
  it("turns away anyone but the authorized user", async () => {
    signedInAs("someone@else.test");

    const response = await PORTAL(new Request("https://ben-os.test/x", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(createSnapTradeClient).not.toHaveBeenCalled();
  });

  it("hands back a portal URL, defaulting to Fidelity", async () => {
    const connectionPortalUrl = vi.fn(async () => "https://app.snaptrade.test/portal?token=abc");
    createSnapTradeClient.mockReturnValue({ connectionPortalUrl });

    const response = await PORTAL(new Request("https://ben-os.test/x", { method: "POST" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redirectUri: "https://app.snaptrade.test/portal?token=abc",
    });
    expect(connectionPortalUrl).toHaveBeenCalledWith(
      expect.objectContaining({ broker: "FIDELITY" }),
    );
  });
});

describe("GET /api/financials/snaptrade/link", () => {
  it("shows both sides of the mapping, so it can be read off and posted back", async () => {
    const { individual } = await arrangeAccounts();

    const body = await (await GET()).json();

    expect(body.snapTradeAccounts.map((a: { id: string }) => a.id)).toEqual([
      FIDELITY_INDIVIDUAL,
      FIDELITY_ROTH,
    ]);
    expect(body.accounts.map((a: { id: string }) => a.id)).toContain(individual);
    expect(body.links).toEqual({});
  });
});

describe("POST /api/financials/snaptrade/link", () => {
  it("stores the authorization and marks each linked account an investment account", async () => {
    const { individual, roth } = await arrangeAccounts();

    const response = await POST(
      linkRequest({ links: { [FIDELITY_INDIVIDUAL]: individual, [FIDELITY_ROTH]: roth } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorizationId: TEST_AUTHORIZATION_ID,
    });

    const { rows } = await asSuperuser((query) =>
      query(`select provider, provider_conn_id, extra from public.financials_connection
              where provider = 'snaptrade'`),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].provider_conn_id).toBe(TEST_AUTHORIZATION_ID);
    expect(rows[0].extra).toMatchObject({
      authorization_id: TEST_AUTHORIZATION_ID,
      accounts: { [FIDELITY_INDIVIDUAL]: individual, [FIDELITY_ROTH]: roth },
    });

    const { rows: accounts } = await asSuperuser((query) =>
      query("select kind from public.financials_account order by name"),
    );

    expect(accounts.map((row) => row.kind)).toEqual(["investment", "investment"]);
  });

  it("refuses an account SnapTrade does not report, rather than syncing nothing forever", async () => {
    const { individual } = await arrangeAccounts();

    const response = await POST(linkRequest({ links: { "st-acct-nonsense": individual } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: /st-acct-nonsense/ });
    expect(await connectionCount()).toBe(1);
  });

  it("refuses an account id this database does not have", async () => {
    await arrangeAccounts();

    const response = await POST(
      linkRequest({ links: { [FIDELITY_INDIVIDUAL]: "00000000-0000-0000-0000-000000000000" } }),
    );

    expect(response.status).toBe(400);
    // The whole call rolls back: a connection stored against a link that names
    // nothing would sync silently into a void.
    expect(await connectionCount()).toBe(1);
  });

  it("refuses accounts spanning two SnapTrade connections", async () => {
    const { individual, roth } = await arrangeAccounts();
    createSnapTradeClient.mockReturnValue({
      listAccounts: async () => [
        account(),
        account({ id: FIDELITY_ROTH, brokerage_authorization: "auth-somewhere-else" }),
      ],
    });

    const response = await POST(
      linkRequest({ links: { [FIDELITY_INDIVIDUAL]: individual, [FIDELITY_ROTH]: roth } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: /different SnapTrade connections/,
    });
  });

  it("rejects a body that is not a link map", async () => {
    await expect(POST(linkRequest({ links: { "st-1": 7 } })).then((r) => r.status)).resolves.toBe(
      400,
    );
    await expect(POST(linkRequest({ links: [] })).then((r) => r.status)).resolves.toBe(400);
    await expect(POST(linkRequest({ links: {} })).then((r) => r.status)).resolves.toBe(400);
  });

  it("turns away anyone but the authorized user, before reaching SnapTrade", async () => {
    signedInAs(null);

    const response = await POST(linkRequest({ links: { "st-1": "a-1" } }));

    expect(response.status).toBe(401);
    expect(createSnapTradeClient).not.toHaveBeenCalled();
  });
});

async function connectionCount(): Promise<number> {
  const { rows } = await asSuperuser((query) =>
    query("select count(*)::int as n from public.financials_connection"),
  );

  return rows[0].n as number;
}

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import FinancialsRawData from "@/app/(modules)/financials/page";

type TableResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Stands in for the PostgREST query builder. Every method the page chains
 * returns the same object, so the shape of the chain doesn't matter here — only
 * which table was asked for and what came back.
 */
function stubSupabase(results: Record<string, TableResult>) {
  createClient.mockResolvedValue({
    from(table: string) {
      const result = results[table] ?? { data: [], error: null };
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        returns: () => Promise.resolve(result),
      };

      return builder;
    },
  });
}

const ok = (data: unknown[]): TableResult => ({ data, error: null });

beforeEach(() => {
  createClient.mockReset();
});

async function renderPage() {
  render(await FinancialsRawData());
}

describe("the financials raw-data view", () => {
  it("lists synced accounts with their balance and connection", async () => {
    stubSupabase({
      financials_account: ok([
        {
          id: "a1",
          name: "Chase Checking",
          kind: "depository",
          status: "active",
          currency: "USD",
          balance: "1500.00",
          available_balance: "1450.00",
          balance_date: "2026-08-01T12:00:00Z",
          provider_account_id: "acct-1",
          financials_connection: { name: "Chase", provider: "simplefin" },
        },
      ]),
    });

    await renderPage();

    const row = screen.getByText("Chase Checking").closest("tr");

    expect(row).not.toBeNull();
    expect(within(row!).getByText("Chase")).toBeInTheDocument();
    expect(within(row!).getByText("$1,500.00")).toBeInTheDocument();
    expect(within(row!).getByText("depository")).toBeInTheDocument();
  });

  it("shows transactions with their sign, which is SimpleFIN's whole meaning", async () => {
    stubSupabase({
      financials_transaction: ok([
        {
          id: "t1",
          posted: "2026-07-30T00:00:00Z",
          description: "COFFEE",
          amount: "-42.50",
          pending: true,
          provider_transaction_id: "txn-1",
          financials_account: { name: "Chase Checking" },
        },
      ]),
    });

    await renderPage();

    const row = screen.getByText("COFFEE").closest("tr");

    expect(within(row!).getByText("-42.50")).toBeInTheDocument();
    expect(within(row!).getByText("pending")).toBeInTheDocument();
  });

  it("renders a balance snapshot against the account it belongs to", async () => {
    stubSupabase({
      financials_balance_snapshot: ok([
        {
          id: "s1",
          balance: "1500.00",
          available_balance: null,
          balance_date: "2026-07-31T23:00:00Z",
          financials_account: { name: "Chase Checking" },
        },
      ]),
    });

    await renderPage();

    const row = screen.getByText("2026-07-31 23:00").closest("tr");

    expect(within(row!).getByText("Chase Checking")).toBeInTheDocument();
    expect(within(row!).getByText("1,500.00")).toBeInTheDocument();
  });

  it("says so plainly when nothing has synced yet", async () => {
    stubSupabase({});

    await renderPage();

    expect(screen.getByText("No accounts synced yet.")).toBeInTheDocument();
    expect(screen.getByText("No transactions yet.")).toBeInTheDocument();
    expect(screen.getByText("No balance snapshots yet.")).toBeInTheDocument();
  });

  it("surfaces a read failure instead of rendering empty tables that look fine", async () => {
    stubSupabase({
      financials_account: { data: null, error: { message: "permission denied" } },
    });

    await renderPage();

    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
  });

  it("falls back to a plain number for a non-ISO currency", async () => {
    // SimpleFIN allows a URL as a currency (rewards points). Intl would throw on
    // it, and a thrown formatter would take the whole page down.
    stubSupabase({
      financials_account: ok([
        {
          id: "a1",
          name: "Points",
          kind: "depository",
          status: "active",
          currency: "https://mycurrency.test/points",
          balance: "12000",
          available_balance: null,
          balance_date: null,
          provider_account_id: "acct-2",
          financials_connection: null,
        },
      ]),
    });

    await renderPage();

    const row = screen.getByText("Points").closest("tr");

    expect(within(row!).getByText("12,000.00")).toBeInTheDocument();
  });
});

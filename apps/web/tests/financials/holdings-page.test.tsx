import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient: createServerClient }));

import HoldingsPage from "@/app/(modules)/financials/holdings/page";

/**
 * The Holdings drill-down, rendered from seeded `financials_holding` rows.
 *
 * Asserted on the assembled page rather than only on `buildHoldingsView`,
 * because the claims worth testing span the query and the derivation together:
 * the page has to ask for the *latest* reading, group what comes back, subtotal
 * each section, and keep a sort inside the section it was clicked in.
 *
 * The fixture is the live shape — two accounts whose syncs stamp `as_of` seconds
 * apart, the same money-market fund in both, and `tax_lots` null on every row
 * except the one case that is specifically about lots (SnapTrade's Personal plan
 * sends none, so null is the normal reading rather than an edge case).
 */

const LATEST = "2026-08-03T13:54:26+00:00";
const EARLIER = "2026-08-03T03:35:39+00:00";
/** The Roth's sync lands two seconds after the Individual's, as it does live. */
const ROTH_LATEST = "2026-08-03T13:54:28+00:00";

const accounts = [
  { id: "ind", name: "Individual (5008)", currency: "USD" },
  { id: "roth", name: "ROTH IRA (3715)", currency: "USD" },
];

type HoldingSeed = {
  account_id: string;
  security_id: string;
  quantity: string;
  average_cost_basis: string | null;
  market_price: string | null;
  currency: string | null;
  tax_lots: unknown;
  as_of: string;
  financials_security: { symbol: string; name: string | null; security_type: string } | null;
};

/**
 * One row, named rather than positional: `cost` and `price` are both decimal
 * strings, and a fixture that told them apart only by argument order would be a
 * fixture nobody could read a total off.
 */
type SeedSpec = {
  symbol: string;
  quantity: string;
  cost: string | null;
  price: string | null;
  type?: string;
  account?: string;
  currency?: string | null;
  asOf?: string;
  taxLots?: unknown;
};

function seed({
  symbol,
  quantity,
  cost,
  price,
  type = "equity",
  account = "ind",
  currency = "USD",
  asOf = LATEST,
  taxLots = null,
}: SeedSpec): HoldingSeed {
  return {
    account_id: account,
    security_id: `${symbol}-${account}`,
    quantity,
    average_cost_basis: cost,
    market_price: price,
    currency,
    tax_lots: taxLots,
    as_of: asOf,
    financials_security: { symbol, name: `${symbol} Inc.`, security_type: type },
  };
}

/**
 * $1,140 across three security types, two of them holding two securities — the
 * second pair is what makes "a sort stayed inside its section" an assertion
 * rather than a claim about a table of one row.
 */
const holdings: HoldingSeed[] = [
  seed({
    symbol: "GOOGL",
    quantity: "2",
    cost: "50",
    price: "100",
    // The one populated lots payload: SnapTrade sends none on Personal, so this
    // is the shape a paid plan would deliver rather than one seen in this data.
    taxLots: [
      { units: "1.5", price: "40.00", acquired_date: "2024-03-01" },
      { units: "0.5", price: "70.00", acquired_date: "2025-11-14" },
    ],
  }),
  seed({ symbol: "AMZN", quantity: "1", cost: "300", price: "250" }),
  seed({ symbol: "URA", type: "etf", quantity: "4", cost: "50", price: "25" }),
  seed({ symbol: "VTI", type: "etf", quantity: "2", cost: "100", price: "120" }),
  seed({ symbol: "SPAXX", type: "cash", quantity: "350", cost: "1", price: "1" }),

  // Last night's reading of the same account. GOOGL was priced at $10 then, and
  // IONQ was still held — neither may appear on a page headed "current".
  seed({ symbol: "GOOGL", quantity: "2", cost: "50", price: "10", asOf: EARLIER }),
  seed({ symbol: "IONQ", quantity: "5", cost: "54.53", price: "36.44", asOf: EARLIER }),

  // The other account, synced two seconds later.
  seed({
    symbol: "VT",
    type: "etf",
    quantity: "3.903",
    cost: "153.7023",
    price: "155.86",
    account: "roth",
    asOf: ROTH_LATEST,
  }),
];

type Failure = { message: string } | null;

function stubServer({
  rows = holdings,
  accountRows = accounts,
  accountsError = null,
  holdingsError = null,
}: {
  rows?: HoldingSeed[];
  accountRows?: typeof accounts;
  accountsError?: Failure;
  holdingsError?: Failure;
} = {}) {
  createServerClient.mockResolvedValue({
    from(table: string) {
      // Records what the page asked for, so the stub can answer the two
      // `financials_holding` queries — the latest `as_of`, then that reading —
      // the way Postgres would, rather than returning one canned list.
      const filters: Record<string, unknown> = {};
      let columns = "";

      const builder = {
        select(selected: string) {
          columns = selected;

          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;

          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        returns() {
          if (table === "financials_account") {
            return Promise.resolve({
              data: accountsError ? null : accountRows,
              error: accountsError,
            });
          }

          if (holdingsError) {
            return Promise.resolve({ data: null, error: holdingsError });
          }

          const mine = rows.filter((row) => row.account_id === filters.account_id);

          if (columns.trim() === "as_of") {
            const latest = mine
              .map((row) => row.as_of)
              .sort()
              .at(-1);

            return Promise.resolve({
              data: latest === undefined ? [] : [{ as_of: latest }],
              error: null,
            });
          }

          return Promise.resolve({
            data: mine.filter((row) => row.as_of === filters.as_of),
            error: null,
          });
        },
      };

      return builder;
    },
  });
}

async function renderPage(account?: string) {
  render(await HoldingsPage({ searchParams: Promise.resolve({ account }) }));
}

function section(label: string): HTMLElement {
  return screen.getByRole("region", { name: `Holdings — ${label}` });
}

/** The symbols in a section's table, in the order they are drawn. */
function symbolsIn(label: string): string[] {
  return within(section(label))
    .getAllByRole("row")
    .filter((row) => within(row).queryAllByRole("cell").length === 8)
    .map((row) => within(row).getAllByRole("cell")[0].firstElementChild?.textContent ?? "");
}

/** One holding's cells, keyed by the column headers above them. */
function cellsFor(label: string, symbol: string): string[] {
  const row = within(section(label))
    .getAllByRole("row")
    .find(
      (candidate) =>
        within(candidate).queryAllByRole("cell").length === 8 &&
        within(candidate).getAllByRole("cell")[0].firstElementChild?.textContent === symbol,
    );

  return within(row as HTMLElement)
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

function sortBy(label: string, column: string) {
  fireEvent.click(within(section(label)).getByRole("button", { name: new RegExp(`^${column}`) }));
}

function figure(label: string): string {
  const strip = screen.getByRole("region", { name: "Summary" });
  const heading = within(strip).getByRole("heading", { name: label });

  return heading.nextElementSibling?.textContent ?? "";
}

beforeEach(() => {
  createServerClient.mockReset();
  stubServer();
});

describe("which rows the page is built from", () => {
  it("shows the latest reading's price, not the one before it", async () => {
    await renderPage("ind");

    // $10.00 was last night's price for the same holding.
    expect(cellsFor("Equities", "GOOGL")[3]).toBe("$100.00");
  });

  it("leaves out a holding that only exists in an older reading", async () => {
    await renderPage("ind");

    // Sold between the two syncs: in last night's snapshot, gone from this
    // morning's, and carrying it forward would be the stale row this resolution
    // exists to prevent.
    expect(screen.queryByText("IONQ")).not.toBeInTheDocument();
  });

  it("reads each account's own latest sync, though they land seconds apart", async () => {
    // A single global maximum `as_of` would empty the Individual account, whose
    // sync finished two seconds before the Roth's.
    await renderPage("ind");

    expect(symbolsIn("Equities")).toEqual(["AMZN", "GOOGL"]);
    expect(screen.queryByText("VT")).not.toBeInTheDocument();
  });

  it("keeps the two accounts' holdings apart", async () => {
    await renderPage("roth");

    expect(symbolsIn("ETFs")).toEqual(["VT"]);
    expect(screen.queryByText("GOOGL")).not.toBeInTheDocument();
  });

  it("stamps the reading every figure came from", async () => {
    await renderPage("ind");

    expect(figure("As of")).toBe("2026-08-03 13:54");
  });
});

describe("the summary strip", () => {
  it("totals market value and cost basis across every holding", async () => {
    await renderPage("ind");

    expect(figure("Market value")).toBe("$1,140.00");
    expect(figure("Cost basis")).toBe("$1,150.00");
  });

  it("reports the unrealized gain in dollars and as a share of what was paid", async () => {
    await renderPage("ind");

    expect(figure("Unrealized gain/loss")).toBe("−$10.00 (−0.9%)");
  });

  it("names the account it is describing", async () => {
    await renderPage("ind");

    expect(screen.getByRole("heading", { name: "Individual (5008)" })).toBeInTheDocument();
  });
});

describe("the allocation strip", () => {
  it("weighs each security type against the account", async () => {
    await renderPage("ind");

    const legend = within(screen.getByRole("region", { name: "Allocation" }));

    expect(legend.getByText("Equities").parentElement?.textContent).toContain("39.5%");
    expect(legend.getByText("Cash & equivalents").parentElement?.textContent).toContain("30.7%");
    expect(legend.getByText("ETFs").parentElement?.textContent).toContain("29.8%");
  });

  it("says out loud that a security's type is its wrapper, not its asset class", async () => {
    await renderPage("ind");

    expect(
      within(screen.getByRole("region", { name: "Allocation" })).getByText(
        /wrapper rather than its asset class/,
      ),
    ).toBeInTheDocument();
  });
});

describe("the sections the ledger is cut into", () => {
  it("gives each security type its own section, heaviest first", async () => {
    await renderPage("ind");

    expect(
      screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label"))
        .filter((label) => label?.startsWith("Holdings — ")),
    ).toEqual(["Holdings — Equities", "Holdings — Cash & equivalents", "Holdings — ETFs"]);
  });

  it("subtotals each section's value and gain in its header", async () => {
    await renderPage("ind");

    const header = within(section("Equities")).getByRole("heading", { name: "Equities" })
      .parentElement?.parentElement;

    expect(header?.textContent).toContain("2 holdings");
    expect(header?.textContent).toContain("$450.00");
    expect(header?.textContent).toContain("+$50.00 (+12.5%)");
  });

  it("says a section came to nothing without claiming a direction for it", async () => {
    await renderPage("ind");

    // A money-market fund held at par gained nothing, and `+$0.00` would claim
    // a direction that a change of nothing does not have.
    const header = within(section("Cash & equivalents")).getByRole("heading", {
      name: "Cash & equivalents",
    }).parentElement?.parentElement;

    expect(header?.textContent).toContain("$0.00 (0.0%)");
  });

  it("gives each holding its value, gain and weight in the account", async () => {
    await renderPage("ind");

    expect(cellsFor("Equities", "AMZN")).toEqual([
      "AMZNAMZN Inc.",
      "1",
      "$300.00",
      "$250.00",
      "$250.00",
      "−$50.00",
      "−16.7%",
      "21.9%",
    ]);
  });
});

describe("sorting a section", () => {
  it("opens every section on its largest holding", async () => {
    await renderPage("ind");

    expect(symbolsIn("Equities")).toEqual(["AMZN", "GOOGL"]);
    expect(symbolsIn("ETFs")).toEqual(["VTI", "URA"]);
  });

  it("reorders only the section whose header was clicked", async () => {
    await renderPage("ind");

    sortBy("Equities", "Quantity");

    expect(symbolsIn("Equities")).toEqual(["GOOGL", "AMZN"]);
    // The whole point of the grouped layout: a sort in one section must not
    // scramble the others.
    expect(symbolsIn("ETFs")).toEqual(["VTI", "URA"]);
  });

  it("reverses the column when it is clicked again", async () => {
    await renderPage("ind");

    sortBy("Equities", "Quantity");
    sortBy("Equities", "Quantity");

    expect(symbolsIn("Equities")).toEqual(["AMZN", "GOOGL"]);
  });

  it("lets two sections be sorted differently at the same time", async () => {
    await renderPage("ind");

    sortBy("Equities", "Quantity");
    sortBy("ETFs", "Quantity");

    expect(symbolsIn("Equities")).toEqual(["GOOGL", "AMZN"]);
    expect(symbolsIn("ETFs")).toEqual(["URA", "VTI"]);
  });

  it("tells a screen reader which column a section is ordered by", async () => {
    await renderPage("ind");

    sortBy("Equities", "Gain/loss %");

    const header = within(section("Equities")).getByRole("columnheader", { name: /Gain\/loss %/ });

    expect(header).toHaveAttribute("aria-sort", "descending");
  });
});

describe("tax lots", () => {
  it("shows the lots behind a holding that came with them", async () => {
    await renderPage("ind");

    fireEvent.click(within(section("Equities")).getByRole("button", { name: "2 lots" }));

    const lots = within(section("Equities")).getByRole("table", { name: /GOOGL — tax lots/ });

    expect(within(lots).getByText("2024-03-01")).toBeInTheDocument();
    expect(within(lots).getByText("$40.00")).toBeInTheDocument();
    // 1.5 units at $40 — the lot's own cost, derived like every other figure.
    expect(within(lots).getByText("$60.00")).toBeInTheDocument();
  });

  it("offers nothing to expand on a holding the provider sent no lots for", async () => {
    await renderPage("ind");

    expect(
      within(section("Cash & equivalents")).queryByRole("button", { name: /lot/ }),
    ).not.toBeInTheDocument();
  });

  it("says why the lots are missing when no holding has them, rather than showing an empty column", async () => {
    // The normal reading on SnapTrade's Personal plan, which reports average
    // cost only — a page that silently showed no lots would look like one that
    // had lost them.
    await renderPage("roth");

    expect(screen.getByText(/No per-lot cost basis in this reading/)).toBeInTheDocument();
  });

  it("stays quiet about lots when at least one holding has them", async () => {
    await renderPage("ind");

    expect(screen.queryByText(/No per-lot cost basis in this reading/)).not.toBeInTheDocument();
  });
});

describe("finding your way in and out", () => {
  it("offers a switch between the investment accounts", async () => {
    await renderPage("ind");

    const nav = within(screen.getByRole("navigation", { name: "Account" }));

    expect(nav.getByRole("link", { name: "ROTH IRA (3715)" })).toHaveAttribute(
      "href",
      "/financials/holdings?account=roth",
    );
    expect(nav.getByRole("link", { name: "Individual (5008)" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("falls back to the first account when the URL names one that isn't there", async () => {
    await renderPage("deleted-account");

    expect(screen.getByRole("heading", { name: "Individual (5008)" })).toBeInTheDocument();
  });

  it("links back to the overview the drill-down came from", async () => {
    await renderPage("ind");

    expect(screen.getByRole("link", { name: /Back to Financials/ })).toHaveAttribute(
      "href",
      "/financials",
    );
  });
});

describe("when there is nothing to show", () => {
  it("says the account has no holdings yet rather than drawing an empty ledger", async () => {
    stubServer({ rows: [] });
    await renderPage("ind");

    expect(screen.getByText(/No holdings synced for Individual \(5008\) yet/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Allocation" })).not.toBeInTheDocument();
  });

  it("says there are no investment accounts at all before one is linked", async () => {
    stubServer({ accountRows: [] });
    await renderPage();

    expect(screen.getByText(/No investment accounts yet/)).toBeInTheDocument();
  });

  it("surfaces a failed read instead of rendering zeroes as though they were figures", async () => {
    stubServer({ holdingsError: { message: "permission denied" } });
    await renderPage("ind");

    expect(
      screen.getByText(/Could not read the holdings tables: permission denied/),
    ).toBeInTheDocument();
  });
});

describe("holdings the provider priced incompletely", () => {
  it("keeps an unpriced holding out of the total and says the total is short of it", async () => {
    stubServer({
      rows: [...holdings, seed({ symbol: "PRIV", quantity: "10", cost: "5", price: null })],
    });
    await renderPage("ind");

    expect(figure("Market value")).toBe("$1,140.00");
    expect(screen.getByText(/1 of 6 holdings came without a market price/)).toBeInTheDocument();
  });

  it("shows a missing figure as absent rather than as zero", async () => {
    stubServer({
      rows: [...holdings, seed({ symbol: "PRIV", quantity: "10", cost: "5", price: null })],
    });
    await renderPage("ind");

    expect(cellsFor("Equities", "PRIV")).toEqual([
      "PRIVPRIV Inc.",
      "10",
      "$5.00",
      "—",
      "—",
      "—",
      "—",
      "—",
    ]);
  });
});

describe("what the totals quietly assume", () => {
  it("warns when the holdings are priced in more than one currency", async () => {
    // v1 has one currency, so this should never fire. Dropping the symbol makes
    // the figure honest about its units and not about its arithmetic — the sum
    // underneath still added two currencies together — so it is said outright.
    stubServer({
      rows: [
        ...holdings,
        seed({ symbol: "SHOP", quantity: "1", cost: "80", price: "90", currency: "CAD" }),
      ],
    });

    await renderPage("ind");

    expect(screen.getByText(/priced in more than one currency/)).toBeInTheDocument();
  });

  it("stays quiet when every holding reports the same currency", async () => {
    await renderPage("ind");

    expect(screen.queryByText(/priced in more than one currency/)).not.toBeInTheDocument();
  });
});

describe("when only some holdings came with lots", () => {
  it("says how many, rather than leaving the missing buttons to be inferred", async () => {
    // The fixture has lots on GOOGL alone. Without this line a reader sees an
    // expander on one row and nothing on the others, and cannot tell whether
    // the rest have no lots or the page failed to load them.
    await renderPage("ind");

    expect(screen.getByText(/Lot detail is shown for the 1 of 5 holdings/)).toBeInTheDocument();
  });
});

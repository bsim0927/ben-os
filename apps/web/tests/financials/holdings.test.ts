import { describe, expect, it } from "vitest";

import {
  buildHoldingsView,
  sortPositions,
  type HoldingSnapshotInput,
  type Position,
} from "@/lib/financials/holdings";

/**
 * What "current holdings" resolves to, and what the figures on top of it are.
 *
 * Every number here is derived rather than stored (ADR 0004 decision 3), so the
 * claims worth pinning are the arithmetic and the *selection*: which rows out of
 * an append-only table count as current, and which are last week's.
 *
 * The fixture's shape is the live one — two accounts syncing minutes apart, the
 * same money-market fund in both, and `tax_lots` null throughout except where a
 * case is specifically about lots (SnapTrade gates lot detail behind its paid
 * plans, so null is the normal reading on Personal).
 */

/** Two readings of the same account, ten hours apart. */
const LATEST = "2026-08-03T13:54:26+00:00";
const EARLIER = "2026-08-03T03:35:39+00:00";

function holding(
  overrides: Partial<HoldingSnapshotInput> & Pick<HoldingSnapshotInput, "symbol">,
): HoldingSnapshotInput {
  return {
    accountId: "ind",
    securityId: overrides.symbol,
    securityName: null,
    securityType: "equity",
    quantity: "1",
    averageCostBasis: "1",
    marketPrice: "1",
    currency: "USD",
    taxLots: null,
    asOf: LATEST,
    ...overrides,
  };
}

/**
 * Nine hundred dollars of positions across three security types, chosen so every
 * total, subtotal and share lands on a figure that can be read rather than
 * recomputed.
 */
const holdings: HoldingSnapshotInput[] = [
  holding({
    symbol: "GOOGL",
    securityName: "Alphabet Inc.",
    quantity: "2",
    averageCostBasis: "50",
    marketPrice: "100",
  }),
  holding({
    symbol: "AMZN",
    securityName: "Amazon.com, Inc.",
    quantity: "1",
    averageCostBasis: "300",
    marketPrice: "250",
  }),
  holding({
    symbol: "URA",
    securityName: "Global X Uranium ETF",
    securityType: "etf",
    quantity: "4",
    averageCostBasis: "50",
    marketPrice: "25",
  }),
  holding({
    symbol: "SPAXX",
    securityName: "Fidelity Government Money Market Fund",
    securityType: "cash",
    quantity: "350",
    averageCostBasis: "1",
    marketPrice: "1",
  }),
];

function view(rows: HoldingSnapshotInput[] = holdings, accountId = "ind") {
  return buildHoldingsView({ accountId, holdings: rows });
}

/** Every position in the view, flattened out of its group. */
function positions(rows?: HoldingSnapshotInput[]): Position[] {
  return view(rows).groups.flatMap((group) => group.positions);
}

function symbols(rows?: HoldingSnapshotInput[]): string[] {
  return positions(rows).map((position) => position.symbol);
}

describe("which rows count as current holdings", () => {
  it("takes the account's latest reading and ignores the one before it", () => {
    const stale = holding({
      symbol: "GOOGL",
      quantity: "2",
      averageCostBasis: "50",
      marketPrice: "10",
      asOf: EARLIER,
    });

    const current = view([stale, ...holdings]);
    const googl = current.groups
      .flatMap((group) => group.positions)
      .find((position) => position.symbol === "GOOGL");

    expect(googl?.marketPrice).toBe(100);
    expect(current.asOf).toBe(LATEST);
  });

  it("drops a position that only exists in an older reading, rather than carrying it forward", () => {
    // Sold between the two syncs: it is in last night's snapshot and not in
    // this morning's, and showing it would be exactly the stale row mixed in
    // with fresher ones that this resolution exists to prevent.
    const sold = holding({ symbol: "IONQ", quantity: "5", marketPrice: "36.44", asOf: EARLIER });

    expect(symbols([sold, ...holdings])).not.toContain("IONQ");
  });

  it("resolves each account's latest reading separately, since their syncs land seconds apart", () => {
    // The Roth's sync stamps a later `as_of` than the Individual's. A single
    // global maximum would empty the Individual account entirely.
    const roth = holding({
      accountId: "roth",
      symbol: "VT",
      securityId: "VT-roth",
      asOf: "2026-08-03T13:54:28+00:00",
    });

    expect(symbols([roth, ...holdings])).toEqual(
      expect.arrayContaining(["GOOGL", "AMZN", "URA", "SPAXX"]),
    );
    expect(symbols([roth, ...holdings])).not.toContain("VT");
  });

  it("leaves other accounts' holdings out of this account's page", () => {
    const roth = holding({ accountId: "roth", symbol: "VT", securityId: "VT-roth" });

    expect(symbols([roth, ...holdings])).not.toContain("VT");
  });

  it("has nothing to show, and no as-of, before the first holdings sync", () => {
    const empty = view([]);

    expect(empty.groups).toEqual([]);
    expect(empty.asOf).toBeNull();
    expect(empty.totalValue).toBe(0);
  });
});

describe("the summary strip", () => {
  it("totals value and cost basis from quantity, never from a stored figure", () => {
    expect(view().totalValue).toBe(900);
    expect(view().totalCostBasis).toBe(950);
  });

  it("reports the unrealized gain as the difference, in dollars and as a share of cost", () => {
    expect(view().gain).toBe(-50);
    expect(view().gainRatio).toBeCloseTo(-50 / 950, 10);
  });

  it("stamps the reading the figures came from", () => {
    expect(view().asOf).toBe(LATEST);
  });

  it("says the currency the account reports in", () => {
    expect(view().currency).toBe("USD");
  });

  it("drops the currency when the positions disagree, rather than stamping one of them on the total", () => {
    const foreign = holding({ symbol: "SHOP", currency: "CAD" });

    expect(view([...holdings, foreign]).currency).toBeUndefined();
  });
});

describe("a position's own figures", () => {
  function position(symbol: string): Position {
    return positions().find((entry) => entry.symbol === symbol) as Position;
  }

  it("multiplies quantity by price for market value, and by average cost for basis", () => {
    expect(position("GOOGL").marketValue).toBe(200);
    expect(position("GOOGL").costBasis).toBe(100);
  });

  it("carries the gain as both a dollar figure and a share of what was paid", () => {
    expect(position("AMZN").gain).toBe(-50);
    expect(position("AMZN").gainRatio).toBeCloseTo(-50 / 300, 10);
  });

  it("weighs each position against the account's total value", () => {
    expect(position("SPAXX").shareOfAccount).toBeCloseTo(350 / 900, 10);
    expect(position("URA").shareOfAccount).toBeCloseTo(100 / 900, 10);
  });

  it("keeps the security's name and type alongside its symbol", () => {
    expect(position("URA").name).toBe("Global X Uranium ETF");
    expect(position("URA").securityType).toBe("etf");
  });
});

describe("a position the provider priced incompletely", () => {
  it("has no market value at all rather than a value of zero", () => {
    const unpriced = holding({ symbol: "PRIV", quantity: "10", marketPrice: null });
    const position = positions([...holdings, unpriced]).find((entry) => entry.symbol === "PRIV");

    expect(position?.marketValue).toBeNull();
    expect(position?.gain).toBeNull();
  });

  it("keeps its absence out of the totals, and says the totals are short of it", () => {
    const unpriced = holding({ symbol: "PRIV", quantity: "10", marketPrice: null });
    const current = view([...holdings, unpriced]);

    expect(current.totalValue).toBe(900);
    expect(current.pricedPositions).toBe(4);
    expect(current.positions).toBe(5);
  });

  it("counts a position with no cost basis toward value but not toward gain", () => {
    // A transferred-in position routinely arrives with no basis. Its value is
    // real; its gain is unknowable, and a zero basis would report the whole
    // position as profit.
    const noBasis = holding({
      symbol: "XFER",
      quantity: "10",
      averageCostBasis: null,
      marketPrice: "10",
    });
    const current = view([...holdings, noBasis]);

    expect(current.totalValue).toBe(1000);
    expect(current.totalCostBasis).toBe(950);
    expect(current.gain).toBe(-50);
    expect(current.costedPositions).toBe(4);
  });

  it("reports no gain ratio for a position that cost nothing, rather than dividing by zero", () => {
    const free = holding({
      symbol: "FREE",
      quantity: "5",
      averageCostBasis: "0",
      marketPrice: "3",
    });
    const position = positions([...holdings, free]).find((entry) => entry.symbol === "FREE");

    expect(position?.gain).toBe(15);
    expect(position?.gainRatio).toBeNull();
  });
});

describe("the sections the ledger is cut into", () => {
  it("groups positions by security type", () => {
    expect(view().groups.map((group) => group.securityType)).toEqual(["equity", "cash", "etf"]);
  });

  it("labels each type in words rather than in the column's raw value", () => {
    expect(view().groups.map((group) => group.label)).toEqual([
      "Equities",
      "Cash & equivalents",
      "ETFs",
    ]);
  });

  it("orders sections by what they are worth, heaviest first", () => {
    expect(view().groups.map((group) => group.value)).toEqual([450, 350, 100]);
  });

  it("breaks a tie between two equally weighted sections on the label, so the order is stable", () => {
    const evened = holdings.map((row) =>
      row.symbol === "SPAXX" ? { ...row, quantity: "450" } : row,
    );

    expect(view(evened).groups.map((group) => group.securityType)).toEqual([
      "cash",
      "equity",
      "etf",
    ]);
  });

  it("subtotals each section's value, cost, gain and position count", () => {
    const [equities] = view().groups;

    expect(equities.count).toBe(2);
    expect(equities.value).toBe(450);
    expect(equities.costBasis).toBe(400);
    expect(equities.gain).toBe(50);
    expect(equities.gainRatio).toBeCloseTo(50 / 400, 10);
  });

  it("weighs each section against the account, so the sections sum to the whole", () => {
    const shares = view().groups.map((group) => group.shareOfAccount as number);

    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 10);
  });

  it("files a security type it has no word for under its raw value rather than hiding it", () => {
    const exotic = holding({ symbol: "ZZZ", securityType: "warrant", marketPrice: "1" });

    expect(view([...holdings, exotic]).groups.map((group) => group.securityType)).toContain(
      "warrant",
    );
  });

  it("opens each section on the largest position", () => {
    const [equities] = view().groups;

    expect(equities.positions.map((position) => position.symbol)).toEqual(["AMZN", "GOOGL"]);
  });
});

describe("tax lots", () => {
  const lots = [
    { units: "1.5", price: "40.00", acquired_date: "2024-03-01" },
    { units: "0.5", price: "70.00", acquired_date: "2025-11-14" },
  ];

  it("reads the lots the provider sent, per lot", () => {
    const withLots = holdings.map((row) =>
      row.symbol === "GOOGL" ? { ...row, taxLots: lots } : row,
    );
    const googl = positions(withLots).find((entry) => entry.symbol === "GOOGL");

    expect(googl?.taxLots).toEqual([
      { quantity: 1.5, costPerUnit: 40, acquiredOn: "2024-03-01" },
      { quantity: 0.5, costPerUnit: 70, acquiredOn: "2025-11-14" },
    ]);
  });

  it("has no lots at all where the column is null, which on this plan is almost always", () => {
    expect(positions().every((position) => position.taxLots === null)).toBe(true);
  });

  it("ignores a lots value that is not a list of lots, rather than failing the page", () => {
    // The column is jsonb and its shape is the provider's, not this app's — a
    // holdings page that threw on an unexpected payload would be worse than one
    // that shows the position without its lots.
    const odd = holdings.map((row) =>
      row.symbol === "GOOGL" ? { ...row, taxLots: { note: "unavailable" } } : row,
    );

    expect(positions(odd).find((entry) => entry.symbol === "GOOGL")?.taxLots).toBeNull();
  });

  it("keeps a lot whose fields it does not recognise, with the parts it could read", () => {
    const partial = holdings.map((row) =>
      row.symbol === "GOOGL" ? { ...row, taxLots: [{ quantity: "2" }] } : row,
    );

    expect(positions(partial).find((entry) => entry.symbol === "GOOGL")?.taxLots).toEqual([
      { quantity: 2, costPerUnit: null, acquiredOn: null },
    ]);
  });
});

describe("sorting within a section", () => {
  const equities = () => view().groups[0].positions;

  it("orders by any column, descending", () => {
    expect(sortPositions(equities(), "quantity", "desc").map((p) => p.symbol)).toEqual([
      "GOOGL",
      "AMZN",
    ]);
    expect(sortPositions(equities(), "gain", "desc").map((p) => p.symbol)).toEqual([
      "GOOGL",
      "AMZN",
    ]);
  });

  it("reverses on ascending", () => {
    expect(sortPositions(equities(), "quantity", "asc").map((p) => p.symbol)).toEqual([
      "AMZN",
      "GOOGL",
    ]);
  });

  it("sorts the name column alphabetically rather than by magnitude", () => {
    expect(sortPositions(equities(), "position", "asc").map((p) => p.symbol)).toEqual([
      "AMZN",
      "GOOGL",
    ]);
  });

  it("puts a figure the provider never sent last, whichever way the column is sorted", () => {
    // A missing price is not a low price, and letting it sort as zero would put
    // an unpriced position at the top of an ascending value column as though it
    // were the cheapest thing in the account.
    const unpriced = holding({ symbol: "PRIV", quantity: "10", marketPrice: null });
    const all = view([...holdings, unpriced]).groups[0].positions;

    expect(
      sortPositions(all, "marketValue", "asc")
        .map((p) => p.symbol)
        .at(-1),
    ).toBe("PRIV");
    expect(
      sortPositions(all, "marketValue", "desc")
        .map((p) => p.symbol)
        .at(-1),
    ).toBe("PRIV");
  });

  it("does not mutate the group it was given", () => {
    const before = equities().map((p) => p.symbol);

    sortPositions(equities(), "quantity", "asc");

    expect(equities().map((p) => p.symbol)).toEqual(before);
  });
});

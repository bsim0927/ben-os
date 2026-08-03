import { describe, expect, it } from "vitest";

import {
  buildFlowPanels,
  type CategoryRef,
  type FlowAccountRef,
  type FlowTransactionInput,
} from "@/lib/financials/flow";

/**
 * The flow summary a depository account's panel is drawn from.
 *
 * All of it is arithmetic over transactions, so it is asserted here without a
 * DOM; the page-level test in `flow-panels-page.test.tsx` covers the claim these
 * figures and the rendered panel are the same thing.
 */

const NOW = new Date("2026-08-02T09:00:00Z");

const chase: FlowAccountRef = {
  id: "chase",
  name: "CHASE COLLEGE (8923)",
  status: "active",
  currency: "USD",
};

const card: FlowAccountRef = {
  id: "card",
  name: "United Explorer (3887)",
  status: "active",
  currency: "USD",
};

const categories: CategoryRef[] = [
  { id: "groceries", name: "Groceries" },
  { id: "rent", name: "Rent" },
  { id: "transit", name: "Transit" },
];

let sequence = 0;

function transaction(
  partial: Partial<FlowTransactionInput> & { posted: string; amount: number | string },
): FlowTransactionInput {
  return {
    id: `t${++sequence}`,
    accountId: "chase",
    description: "Transaction",
    pending: false,
    categoryId: null,
    ...partial,
  };
}

function panelsFor(
  transactions: FlowTransactionInput[],
  options: { accounts?: FlowAccountRef[]; period?: "1M" | "3M" | "1Y" | "ALL" } = {},
) {
  return buildFlowPanels({
    accounts: options.accounts ?? [chase],
    transactions,
    categories,
    period: options.period ?? "3M",
    now: NOW,
  });
}

describe("the flow summary", () => {
  it("splits money in from money out, and nets them", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "2500.00", description: "PAYROLL" }),
      transaction({ posted: "2026-07-30T12:00:00Z", amount: "-1200.00", description: "RENT" }),
      transaction({ posted: "2026-07-29T12:00:00Z", amount: "-85.50", description: "GROCERIES" }),
    ]);

    expect(panel.stats).toEqual({ income: 2500, expenses: 1285.5, net: 1214.5 });
  });

  it("reads amounts that arrive as decimal strings, and rounds the sum to cents", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "0.10" }),
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "0.20" }),
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-0.30" }),
    ]);

    expect(panel.stats).toEqual({ income: 0.3, expenses: 0.3, net: 0 });
  });

  it("counts a pending transaction — the money has moved even if the bank hasn't settled", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-40.00", pending: true }),
    ]);

    expect(panel.stats.expenses).toBe(40);
    expect(panel.transactions[0].pending).toBe(true);
  });

  it("keeps each account's transactions to its own panel", () => {
    const [chasePanel, cardPanel] = panelsFor(
      [
        transaction({ posted: "2026-07-31T12:00:00Z", amount: "-10.00", accountId: "chase" }),
        transaction({ posted: "2026-07-31T12:00:00Z", amount: "-99.00", accountId: "card" }),
      ],
      { accounts: [chase, card] },
    );

    expect(chasePanel.stats.expenses).toBe(10);
    expect(cardPanel.stats.expenses).toBe(99);
  });

  it("ignores a transaction whose account is not on the page at all", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-10.00", accountId: "fidelity" }),
    ]);

    expect(panel.stats).toEqual({ income: 0, expenses: 0, net: 0 });
  });
});

describe("the flow period", () => {
  const spread = [
    transaction({ posted: "2025-08-01T12:00:00Z", amount: "-1.00" }),
    transaction({ posted: "2026-03-01T12:00:00Z", amount: "-10.00" }),
    transaction({ posted: "2026-06-01T12:00:00Z", amount: "-100.00" }),
    transaction({ posted: "2026-07-25T12:00:00Z", amount: "-1000.00" }),
  ];

  it("keeps the last 30 days on 1M", () => {
    expect(panelsFor(spread, { period: "1M" })[0].stats.expenses).toBe(1000);
  });

  it("keeps the last 90 days on 3M", () => {
    expect(panelsFor(spread, { period: "3M" })[0].stats.expenses).toBe(1100);
  });

  it("keeps the last year on 1Y", () => {
    expect(panelsFor(spread, { period: "1Y" })[0].stats.expenses).toBe(1110);
  });

  it("keeps every transaction there has ever been on ALL", () => {
    expect(panelsFor(spread, { period: "ALL" })[0].stats.expenses).toBe(1111);
  });
});

describe("the category bars", () => {
  it("breaks expenses down by category, largest first", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-1200.00", categoryId: "rent" }),
      transaction({ posted: "2026-07-30T12:00:00Z", amount: "-60.00", categoryId: "groceries" }),
      transaction({ posted: "2026-07-29T12:00:00Z", amount: "-140.00", categoryId: "groceries" }),
      transaction({ posted: "2026-07-28T12:00:00Z", amount: "-50.00", categoryId: "transit" }),
    ]);

    expect(panel.bars.map((bar) => [bar.label, bar.amount])).toEqual([
      ["Rent", 1200],
      ["Groceries", 200],
      ["Transit", 50],
    ]);
  });

  it("sizes each bar against the total expenses, so the shares add to one", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-75.00", categoryId: "rent" }),
      transaction({ posted: "2026-07-30T12:00:00Z", amount: "-25.00", categoryId: "groceries" }),
    ]);

    expect(panel.bars.map((bar) => bar.share)).toEqual([0.75, 0.25]);
  });

  it("gives what has not been categorized yet its own bar, sorted on its size like any other", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-300.00" }),
      transaction({ posted: "2026-07-30T12:00:00Z", amount: "-500.00", categoryId: "rent" }),
      transaction({ posted: "2026-07-29T12:00:00Z", amount: "-100.00", categoryId: "groceries" }),
    ]);

    expect(panel.bars.map((bar) => [bar.categoryId, bar.label, bar.amount])).toEqual([
      ["rent", "Rent", 500],
      [null, "Uncategorized", 300],
      ["groceries", "Groceries", 100],
    ]);
  });

  it("leaves income out of the breakdown — these are expense bars", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "5000.00", categoryId: "rent" }),
      transaction({ posted: "2026-07-30T12:00:00Z", amount: "-40.00", categoryId: "transit" }),
    ]);

    expect(panel.bars.map((bar) => [bar.label, bar.amount])).toEqual([["Transit", 40]]);
  });

  it("gives no bar to a category nothing was spent on", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-40.00", categoryId: "transit" }),
    ]);

    expect(panel.bars.map((bar) => bar.label)).toEqual(["Transit"]);
  });

  it("breaks a tie by name, so equal spend does not reorder between renders", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-40.00", categoryId: "transit" }),
      transaction({ posted: "2026-07-30T12:00:00Z", amount: "-40.00", categoryId: "groceries" }),
    ]);

    expect(panel.bars.map((bar) => bar.label)).toEqual(["Groceries", "Transit"]);
  });

  it("counts spend against a category that no longer exists as uncategorized", () => {
    // `category_id` is `on delete set null`, so this should not happen — but a
    // bar labelled `undefined` would be a worse way to find out that it did.
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-40.00", categoryId: "deleted" }),
    ]);

    expect(panel.bars).toEqual([
      { categoryId: null, label: "Uncategorized", amount: 40, share: 1 },
    ]);
  });

  it("has no bars, and no division by zero, in a period with no spending", () => {
    const [panel] = panelsFor([transaction({ posted: "2026-07-31T12:00:00Z", amount: "500.00" })]);

    expect(panel.bars).toEqual([]);
  });
});

describe("the flow trend", () => {
  it("runs net flow up day by day, ending on the net the panel reports", () => {
    const [panel] = panelsFor([
      transaction({ posted: "2026-07-29T12:00:00Z", amount: "1000.00" }),
      transaction({ posted: "2026-07-30T09:00:00Z", amount: "-200.00" }),
      transaction({ posted: "2026-07-30T18:00:00Z", amount: "-100.00" }),
      transaction({ posted: "2026-08-01T12:00:00Z", amount: "-50.00" }),
    ]);

    expect(panel.trend).toEqual([
      { date: "2026-07-29", total: 1000 },
      { date: "2026-07-30", total: 700 },
      { date: "2026-08-01", total: 650 },
    ]);
    expect(panel.trend.at(-1)?.total).toBe(panel.stats.net);
  });

  it("has nothing to trend in an empty period", () => {
    const [panel] = panelsFor([]);

    expect(panel.trend).toEqual([]);
    expect(panel.stats).toEqual({ income: 0, expenses: 0, net: 0 });
  });
});

describe("the transaction list", () => {
  it("lists the period's transactions newest first, with each category named", () => {
    const [panel] = panelsFor([
      transaction({
        posted: "2026-07-29T12:00:00Z",
        amount: "-20.00",
        description: "METRO",
        categoryId: "transit",
      }),
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-30.00", description: "CORNER SHOP" }),
    ]);

    expect(panel.transactions.map((row) => [row.description, row.categoryName])).toEqual([
      ["CORNER SHOP", null],
      ["METRO", "Transit"],
    ]);
  });

  it("orders same-day transactions by id, so a re-render cannot shuffle them", () => {
    const rows = [
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-1.00", id: "b" }),
      transaction({ posted: "2026-07-31T12:00:00Z", amount: "-2.00", id: "a" }),
    ];

    expect(panelsFor(rows)[0].transactions.map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("which accounts get a panel", () => {
  it("gives an active account a panel even before it has any transactions", () => {
    expect(panelsFor([]).map((panel) => panel.account.id)).toEqual(["chase"]);
  });

  it("keeps a closed account's panel only while the period still holds its history", () => {
    const closed: FlowAccountRef = { ...card, status: "closed" };
    const spend = transaction({
      posted: "2026-03-01T12:00:00Z",
      amount: "-10.00",
      accountId: "card",
    });

    expect(
      buildFlowPanels({
        accounts: [chase, closed],
        transactions: [spend],
        categories,
        period: "1Y",
        now: NOW,
      }).map((panel) => panel.account.id),
    ).toEqual(["chase", "card"]);

    expect(
      buildFlowPanels({
        accounts: [chase, closed],
        transactions: [spend],
        categories,
        period: "1M",
        now: NOW,
      }).map((panel) => panel.account.id),
    ).toEqual(["chase"]);
  });
});

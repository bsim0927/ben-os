import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import FinancialsOverview from "@/app/(modules)/financials/page";

/**
 * The overview against seeded balance snapshots.
 *
 * The point of asserting here rather than only on `buildNetWorthSeries` is that
 * the chart and the equation strip are supposed to be two views of one series —
 * a page-level test is the only place that claim can actually fail.
 *
 * The chart's figures are read off its text alternative, which carries exactly
 * the numbers the path is drawn from.
 */

const TODAY = new Date("2026-08-02T09:00:00Z");

type TableResult = { data: unknown[] | null; error: { message: string } | null };

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

const accounts = [
  {
    id: "chase",
    name: "CHASE COLLEGE (8923)",
    kind: "depository",
    status: "active",
    currency: "USD",
  },
  {
    id: "fidelity",
    name: "Individual (5008)",
    kind: "investment",
    status: "active",
    currency: "USD",
  },
];

function snapshot(accountId: string, day: string, balance: string) {
  return { account_id: accountId, balance, balance_date: `${day}T12:00:00Z` };
}

/**
 * Five polls, spaced so each range toggle admits a different number of them:
 * ALL sees all five, 1Y the last four, 3M the last three, 1M the last two.
 */
const snapshots = [
  snapshot("chase", "2024-08-01", "1000.00"),
  snapshot("fidelity", "2024-08-01", "9000.00"),
  snapshot("chase", "2026-01-05", "2000.00"),
  snapshot("fidelity", "2026-01-05", "18000.00"),
  snapshot("chase", "2026-06-01", "3000.00"),
  snapshot("fidelity", "2026-06-01", "27000.00"),
  snapshot("chase", "2026-07-20", "4000.00"),
  snapshot("fidelity", "2026-07-20", "36000.00"),
  snapshot("chase", "2026-08-01", "5000.00"),
  snapshot("fidelity", "2026-08-01", "45000.00"),
];

function seeded() {
  stubSupabase({
    financials_account: { data: accounts, error: null },
    financials_balance_snapshot: { data: snapshots, error: null },
  });
}

async function renderPage() {
  render(await FinancialsOverview());
}

/**
 * The net worth chart's text alternative.
 *
 * Found by its caption rather than as *the* table on the page: each balance
 * bridge below carries one too, and an unscoped lookup would break on whichever
 * panel happened to render first.
 */
function chartTable(): HTMLElement {
  return screen.getByRole("table", { name: /Net worth by day/ });
}

/** `[date, net worth]` for every point the chart is drawn from. */
function chartData(): [string, string][] {
  const rows = within(chartTable()).getAllByRole("row").slice(1);

  return rows.map((row) => [
    within(row).getByRole("rowheader").textContent ?? "",
    within(row).getByRole("cell").textContent ?? "",
  ]);
}

function equationStrip(): HTMLElement {
  return screen.getByRole("region", { name: "Net worth equation" });
}

/**
 * The headline block — the total, and the change across the window.
 *
 * Scoped to the `Net worth` heading rather than searched for on the page, for
 * the reason the range toggle is: each balance bridge below reports its own
 * account's change in the same words, and `over 1 month` alone is ambiguous
 * between them.
 */
function heroHeadline(): HTMLElement {
  return screen.getByRole("heading", { level: 1, name: "Net worth" }).parentElement as HTMLElement;
}

/** `[label, value]` for each term of `a + b = net worth`. */
function equationTerms(): [string, string][] {
  return within(equationStrip())
    .getAllByRole("heading", { level: 3 })
    .map((heading) => [heading.textContent ?? "", heading.nextElementSibling?.textContent ?? ""]);
}

/**
 * Scoped to the chart's own toggle: the flow panels below carry a period toggle
 * spelled the same way, and an unscoped `1M` would be ambiguous between them.
 */
function rangeButton(range: string): HTMLElement {
  return within(screen.getByRole("group", { name: "Chart range" })).getByRole("button", {
    name: range,
  });
}

function selectRange(range: string) {
  fireEvent.click(rangeButton(range));
}

beforeEach(() => {
  createClient.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the financials overview", () => {
  it("opens on 3 months, charting one point per day of snapshots in the window", async () => {
    seeded();
    await renderPage();

    expect(rangeButton("3M")).toHaveAttribute("aria-pressed", "true");
    expect(chartData()).toEqual([
      ["1 Jun 2026", "$30,000.00"],
      ["20 Jul 2026", "$40,000.00"],
      ["1 Aug 2026", "$50,000.00"],
    ]);
  });

  it("narrows the chart to the last 30 days on 1M", async () => {
    seeded();
    await renderPage();

    selectRange("1M");

    expect(chartData()).toEqual([
      ["20 Jul 2026", "$40,000.00"],
      ["1 Aug 2026", "$50,000.00"],
    ]);
  });

  it("reaches back a year on 1Y", async () => {
    seeded();
    await renderPage();

    selectRange("1Y");

    expect(chartData()).toEqual([
      ["5 Jan 2026", "$20,000.00"],
      ["1 Jun 2026", "$30,000.00"],
      ["20 Jul 2026", "$40,000.00"],
      ["1 Aug 2026", "$50,000.00"],
    ]);
  });

  it("charts every snapshot there has ever been on ALL", async () => {
    seeded();
    await renderPage();

    selectRange("ALL");

    expect(chartData()).toEqual([
      ["1 Aug 2024", "$10,000.00"],
      ["5 Jan 2026", "$20,000.00"],
      ["1 Jun 2026", "$30,000.00"],
      ["20 Jul 2026", "$40,000.00"],
      ["1 Aug 2026", "$50,000.00"],
    ]);
  });

  it("reads the equation strip as Chase + Fidelity = Net worth", async () => {
    seeded();
    await renderPage();

    expect(equationStrip().textContent).toMatch(
      /CHASE COLLEGE \(8923\)[\s\S]*\+[\s\S]*Individual \(5008\)[\s\S]*=[\s\S]*Net worth/,
    );
  });

  it("hides the chart's data table on the wrapper, so the caption goes with it", async () => {
    seeded();
    await renderPage();

    const table = chartTable();

    // `sr-only` has to sit on an ancestor rather than on the table itself: a
    // `<caption>` box is generated by the table *wrapper*, outside the grid the
    // table's `overflow: hidden` clips, so hiding the table leaves the caption
    // rendering in full over the chart. This shipped once; it should not again.
    expect(table).not.toHaveClass("sr-only");
    expect(table.closest(".sr-only")).not.toBeNull();
    expect(within(table).getByText(/Net worth by day/)).toBeInTheDocument();
  });

  it("gives every account its own term, all four of them", async () => {
    // The real subscription: a card and a checking account behind the Chase
    // login, two funds behind Fidelity's. The card sitting negative next to the
    // checking account is the whole reason this is per-account and not per
    // institution — folding them together would hide it.
    stubSupabase({
      financials_account: {
        // Listed the way `.order("name")` returns them, so the terms come out in
        // the order the real page puts them in.
        data: [
          ...accounts,
          {
            id: "roth",
            name: "ROTH IRA (3715)",
            kind: "investment",
            status: "active",
            currency: "USD",
          },
          {
            id: "card",
            name: "United Explorer (3887)",
            kind: "depository",
            status: "active",
            currency: "USD",
          },
        ],
        error: null,
      },
      financials_balance_snapshot: {
        data: [
          snapshot("chase", "2026-08-01", "2018.85"),
          snapshot("card", "2026-08-01", "-2309.28"),
          snapshot("fidelity", "2026-08-01", "5334.03"),
          snapshot("roth", "2026-08-01", "608.86"),
          snapshot("chase", "2026-08-02", "2018.85"),
          snapshot("card", "2026-08-02", "-2309.28"),
          snapshot("fidelity", "2026-08-02", "5334.03"),
          snapshot("roth", "2026-08-02", "608.86"),
        ],
        error: null,
      },
    });

    await renderPage();

    expect(equationTerms()).toEqual([
      ["CHASE COLLEGE (8923)", "$2,018.85"],
      ["Individual (5008)", "$5,334.03"],
      ["ROTH IRA (3715)", "$608.86"],
      ["United Explorer (3887)", "-$2,309.28"],
      ["Net worth", "$5,652.46"],
    ]);
  });

  it("explains a single reading instead of drawing a lone dot on an empty grid", async () => {
    // Every account's first day: balance history cannot be backfilled, so this
    // is what the page looks like until the second poll lands.
    stubSupabase({
      financials_account: { data: accounts, error: null },
      financials_balance_snapshot: {
        data: [
          snapshot("chase", "2026-08-02", "2018.85"),
          snapshot("fidelity", "2026-08-02", "5334.03"),
        ],
        error: null,
      },
    });

    await renderPage();

    expect(screen.getByText(/One balance reading so far, from 2 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByText(/one point per sync/)).toBeInTheDocument();
    // No chart, so no data table standing in for one.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // The money is still real and still adds up.
    expect(equationTerms()).toEqual([
      ["CHASE COLLEGE (8923)", "$2,018.85"],
      ["Individual (5008)", "$5,334.03"],
      ["Net worth", "$7,352.88"],
    ]);
  });

  it("gives the equation strip the same figures the chart ends on, in every range", async () => {
    seeded();
    await renderPage();

    for (const range of ["1M", "3M", "1Y", "ALL"]) {
      selectRange(range);

      const terms = equationTerms();
      const [, latestOnChart] = chartData().at(-1)!;

      expect(terms).toEqual([
        ["CHASE COLLEGE (8923)", "$5,000.00"],
        ["Individual (5008)", "$45,000.00"],
        ["Net worth", "$50,000.00"],
      ]);
      // The claim the strip exists to make: the total is the sum of the terms,
      // and it is the point the chart ends on — not a number computed apart.
      expect(terms.at(-1)?.[1]).toBe(latestOnChart);
    }
  });

  it("reports the change across the window, which is what the toggle changes", async () => {
    seeded();
    await renderPage();

    expect(within(heroHeadline()).getByText("+$20,000.00")).toBeInTheDocument();
    expect(within(heroHeadline()).getByText(/over 3 months/)).toBeInTheDocument();

    selectRange("1M");

    expect(within(heroHeadline()).getByText("+$10,000.00")).toBeInTheDocument();
    expect(within(heroHeadline()).getByText(/over 1 month/)).toBeInTheDocument();

    selectRange("ALL");

    expect(within(heroHeadline()).getByText("+$40,000.00")).toBeInTheDocument();
    expect(within(heroHeadline()).getByText(/over all time/)).toBeInTheDocument();
  });

  it("sums only the accounts that were reporting on a given day", async () => {
    // Fidelity's first snapshot lands a day after Chase's — the earlier day is
    // Chase alone, not Chase plus a Fidelity balance that did not exist yet.
    stubSupabase({
      financials_account: { data: accounts, error: null },
      financials_balance_snapshot: {
        data: [
          snapshot("chase", "2026-07-30", "1000.00"),
          snapshot("chase", "2026-07-31", "1000.00"),
          snapshot("fidelity", "2026-07-31", "9000.00"),
        ],
        error: null,
      },
    });

    await renderPage();

    expect(chartData()).toEqual([
      ["30 Jul 2026", "$1,000.00"],
      ["31 Jul 2026", "$10,000.00"],
    ]);
  });

  it("holds a balance steady through a poll that missed one institution", async () => {
    stubSupabase({
      financials_account: { data: accounts, error: null },
      financials_balance_snapshot: {
        data: [
          snapshot("chase", "2026-07-30", "1000.00"),
          snapshot("fidelity", "2026-07-30", "9000.00"),
          snapshot("fidelity", "2026-07-31", "9500.00"),
        ],
        error: null,
      },
    });

    await renderPage();

    expect(chartData().at(-1)).toEqual(["31 Jul 2026", "$10,500.00"]);
    expect(equationTerms()).toEqual([
      ["CHASE COLLEGE (8923)", "$1,000.00"],
      ["Individual (5008)", "$9,500.00"],
      ["Net worth", "$10,500.00"],
    ]);
  });

  it("keeps showing the real balances when the chosen range has no snapshots in it", async () => {
    // Sync has been broken for months. 1M has nothing to draw — but the money is
    // still there, and a headline of $0.00 would be confidently wrong.
    stubSupabase({
      financials_account: { data: accounts, error: null },
      financials_balance_snapshot: {
        data: [
          snapshot("chase", "2026-01-05", "2000.00"),
          snapshot("fidelity", "2026-01-05", "18000.00"),
        ],
        error: null,
      },
    });

    await renderPage();

    selectRange("1M");

    expect(screen.getByText(/No balance readings in the last 1 month/)).toBeInTheDocument();
    expect(equationTerms()).toEqual([
      ["CHASE COLLEGE (8923)", "$2,000.00"],
      ["Individual (5008)", "$18,000.00"],
      ["Net worth", "$20,000.00"],
    ]);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("says plainly that there is nothing to chart before the first sync", async () => {
    stubSupabase({
      financials_account: { data: accounts, error: null },
      financials_balance_snapshot: { data: [], error: null },
    });

    await renderPage();

    expect(screen.getByText(/No balance snapshots yet/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Net worth equation" })).not.toBeInTheDocument();
  });

  it("surfaces a read failure instead of charting a net worth of nothing", async () => {
    stubSupabase({
      financials_balance_snapshot: { data: null, error: { message: "permission denied" } },
    });

    await renderPage();

    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
  });

  it("keeps the raw sync rows one click away", async () => {
    seeded();
    await renderPage();

    expect(screen.getByRole("link", { name: "Raw sync data" })).toHaveAttribute(
      "href",
      "/financials/raw",
    );
  });
});

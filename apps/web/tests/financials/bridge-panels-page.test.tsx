import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClient, createBrowserClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createBrowserClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: createServerClient }));
vi.mock("@/lib/supabase/client", () => ({ createClient: createBrowserClient }));

import FinancialsOverview from "@/app/(modules)/financials/page";

/**
 * The Fidelity balance bridge, rendered from seeded transaction and
 * balance-snapshot rows.
 *
 * Asserted on the assembled page rather than only on `buildBridgePanels`,
 * because the claim worth testing spans both tables: the segments have to be the
 * tagged activity in `financials_transaction`, the ends have to be real readings
 * from `financials_balance_snapshot`, and the two have to reconcile once drawn.
 *
 * The transaction descriptions are the ones the live SimpleFIN feed actually
 * sends, copied from the synced rows — including their signs, which do not mean
 * what SimpleFIN's convention says they mean on this feed.
 */

const TODAY = new Date("2026-08-02T09:00:00Z");

type TableResult = { data: unknown[] | null; error: { message: string } | null };

function stubServer(results: Record<string, TableResult>) {
  createServerClient.mockResolvedValue({
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
  { id: "roth", name: "ROTH IRA (3715)", kind: "investment", status: "active", currency: "USD" },
];

function snapshot(accountId: string, day: string, balance: string) {
  return { account_id: accountId, balance, balance_date: `${day}T08:08:47+00:00` };
}

/**
 * Three readings of the brokerage account and two of the Roth. The middle
 * Fidelity reading is what lets a narrower period open somewhere else.
 */
const snapshots = [
  snapshot("fidelity", "2026-08-01", "11000.00"),
  snapshot("fidelity", "2026-07-15", "10250.00"),
  snapshot("fidelity", "2026-07-01", "10000.00"),
  snapshot("roth", "2026-08-01", "2600.00"),
  snapshot("roth", "2026-07-01", "2000.00"),
  snapshot("chase", "2026-08-01", "4200.00"),
];

function transaction(
  id: string,
  accountId: string,
  posted: string,
  description: string,
  amount: string,
) {
  return {
    id,
    account_id: accountId,
    posted: `${posted}T12:00:00+00:00`,
    description,
    amount,
    pending: false,
    category_id: null,
  };
}

const transactions = [
  // Money into the brokerage. The feed reports an inbound transfer as negative —
  // Chase posts the matching −2,400 the same day — so only the wording says which
  // way it went.
  transaction(
    "f1",
    "fidelity",
    "2026-07-10",
    "Electronic Funds Transfer Received (Cash)",
    "-500.00",
  ),
  transaction(
    "f2",
    "fidelity",
    "2026-07-20",
    "DIVIDEND RECEIVED ALPHABET INC CAP STK CL A (GOOGL) (Cash)",
    "25.00",
  ),
  // The reinvestment that immediately spends that dividend: cash into shares,
  // inside the same account, changing its value by nothing.
  transaction(
    "f3",
    "fidelity",
    "2026-07-20",
    "REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)",
    "-25.00",
  ),
  // Worded as a contribution, but it is one to the *Roth* — money leaving here.
  transaction(
    "f4",
    "fidelity",
    "2026-07-25",
    "TRANSFERRED TO VS XXX-XXX715-1 CURRENT CONTRIBUTION (Cash)",
    "-100.00",
  ),
  transaction("f5", "fidelity", "2026-07-28", "ADVISORY FEE (Cash)", "-15.00"),
  transaction("r1", "roth", "2026-07-25", "CASH CONTRIBUTION CURRENT YEAR (Cash)", "-100.00"),
  transaction("c1", "chase", "2026-07-31", "PAYROLL DIRECT DEP", "3000.00"),
];

function seeded(overrides: Partial<Record<string, TableResult>> = {}) {
  stubServer({
    financials_account: { data: accounts, error: null },
    financials_balance_snapshot: { data: snapshots, error: null },
    financials_transaction: { data: transactions, error: null },
    financials_category: { data: [], error: null },
    ...overrides,
  });
}

async function renderPage() {
  render(await FinancialsOverview());
}

function panel(accountName: string): HTMLElement {
  return screen.getByRole("region", { name: `Balance bridge — ${accountName}` });
}

/** `[segment, amount]` for the bridge, in the order it is drawn. */
function segments(accountName: string): [string, string][] {
  const table = within(panel(accountName)).getByRole("table");

  return within(table)
    .getAllByRole("rowheader")
    .map((header) => [header.textContent ?? "", header.nextElementSibling?.textContent ?? ""]);
}

/** Back from a rendered amount to a number — note the U+2212 the formatter uses. */
function parseAmount(rendered: string): number {
  return Number(rendered.replace(/[$,+]/g, "").replace("−", "-"));
}

function selectPeriod(period: string) {
  fireEvent.click(
    within(screen.getByRole("group", { name: "Bridge period" })).getByRole("button", {
      name: period,
    }),
  );
}

beforeEach(() => {
  createServerClient.mockReset();
  createBrowserClient.mockReset();
  createBrowserClient.mockReturnValue({ from: () => ({}) });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which accounts get a bridge panel", () => {
  it("gives one to each investment account", async () => {
    seeded();
    await renderPage();

    expect(panel("Individual (5008)")).toBeInTheDocument();
    expect(panel("ROTH IRA (3715)")).toBeInTheDocument();
  });

  it("leaves the depository account out — its framing is flow, not the bridge", async () => {
    seeded();
    await renderPage();

    expect(
      screen.queryByRole("region", { name: "Balance bridge — CHASE COLLEGE (8923)" }),
    ).not.toBeInTheDocument();
  });

  it("drops the whole section when nothing synced is a fit for the bridge framing", async () => {
    seeded({ financials_account: { data: [accounts[0]], error: null } });
    await renderPage();

    expect(screen.queryByRole("region", { name: "Balance bridge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Bridge period" })).not.toBeInTheDocument();
  });
});

describe("the bridge chart", () => {
  it("runs Start through to End, in the order the balance moved", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    expect(segments("Individual (5008)")).toEqual([
      ["Start", "$10,000.00"],
      ["Contributions", "+$400.00"],
      ["Dividends", "+$25.00"],
      ["Growth", "+$590.00"],
      ["Fees", "−$15.00"],
      ["End", "$11,000.00"],
    ]);
  });

  it("opens and closes on the real balance readings either end of the window", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    expect(
      within(panel("Individual (5008)")).getByText(
        "Balance bridge for Individual (5008), 1 Jul 2026 to 1 Aug 2026",
      ),
    ).toBeInTheDocument();
  });

  it("reconciles exactly to the balance delta", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    const rows = segments("Individual (5008)");
    const amounts = rows.map(([, amount]) => parseAmount(amount));
    const [start, ...rest] = amounts;
    const end = rest.pop() as number;

    expect(start + rest.reduce((sum, value) => sum + value, 0)).toBe(end);
    expect(end - start).toBe(1000);
  });

  it("nets a transfer out against the money that came in, rather than counting both as in", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    // +500 arrived, 100 left for the Roth. Reading "CURRENT CONTRIBUTION" off
    // the outbound row would print +$600.00 here and understate growth by 200.
    expect(segments("Individual (5008)")[1]).toEqual(["Contributions", "+$400.00"]);
  });

  it("counts a dividend once, not against the reinvestment that spent it", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    // The reinvestment moves cash into shares inside the account. Counting its
    // −25 anywhere would take the dividend straight back out of growth.
    expect(segments("Individual (5008)")[2]).toEqual(["Dividends", "+$25.00"]);
    expect(segments("Individual (5008)")[3]).toEqual(["Growth", "+$590.00"]);
  });

  it("keeps each account's activity to its own bridge", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    expect(segments("ROTH IRA (3715)")).toEqual([
      ["Start", "$2,000.00"],
      ["Contributions", "+$100.00"],
      // A period with no dividends and no fees, said without a sign: `+$0.00`
      // would claim a direction that a change of nothing does not have.
      ["Dividends", "$0.00"],
      ["Growth", "+$500.00"],
      ["Fees", "$0.00"],
      ["End", "$2,600.00"],
    ]);
  });

  it("says how far the balance moved beside the account's name", async () => {
    seeded();
    await renderPage();

    selectPeriod("ALL");

    expect(
      within(panel("Individual (5008)")).getByText("+$1,000.00 over all time"),
    ).toBeInTheDocument();
  });
});

describe("the period the bridge covers", () => {
  it("opens on the last 30 days", async () => {
    seeded();
    await renderPage();

    expect(
      within(screen.getByRole("group", { name: "Bridge period" })).getByRole("button", {
        name: "1M",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("moves the start balance forward, and counts only what happened after it", async () => {
    seeded();
    await renderPage();

    // 1M reaches back to 3 July, so the window opens on the 15 July reading —
    // which already contains the 10 July contribution.
    expect(segments("Individual (5008)")).toEqual([
      ["Start", "$10,250.00"],
      ["Contributions", "−$100.00"],
      ["Dividends", "+$25.00"],
      ["Growth", "+$840.00"],
      ["Fees", "−$15.00"],
      ["End", "$11,000.00"],
    ]);
  });

  it("still reconciles once the window has moved", async () => {
    seeded();
    await renderPage();

    const amounts = segments("Individual (5008)").map(([, amount]) => parseAmount(amount));
    const [start, ...rest] = amounts;
    const end = rest.pop() as number;

    expect(start + rest.reduce((sum, value) => sum + value, 0)).toBe(end);
  });

  it("says there is nothing to bridge rather than drawing a bridge of zeroes", async () => {
    // Balance history accrues one reading per sync and cannot be backfilled, so
    // a freshly linked account genuinely has one point and no change to explain.
    seeded({
      financials_balance_snapshot: {
        data: [snapshot("fidelity", "2026-08-01", "11000.00")],
        error: null,
      },
    });
    await renderPage();

    expect(
      within(panel("Individual (5008)")).getByText(/No two balance readings in the last 1 month/),
    ).toBeInTheDocument();
    expect(within(panel("Individual (5008)")).queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("when the page hits its row bound", () => {
  it("says so, because the missing activity becomes growth rather than going missing", async () => {
    // The one way this panel can be wrong while still adding up: growth is the
    // residual, so activity the page never loaded is silently attributed to the
    // market instead of to the contribution that actually caused it.
    seeded({
      financials_transaction: {
        data: Array.from({ length: 1000 }, (_, index) =>
          transaction(`bulk-${index}`, "chase", "2026-07-20", "COFFEE", "-3.00"),
        ),
        error: null,
      },
    });
    await renderPage();

    expect(
      within(screen.getByRole("region", { name: "Balance bridge" })).getByText(
        /Only the 1,000 most recent transactions are loaded — activity before that is counted as growth/,
      ),
    ).toBeInTheDocument();
  });

  it("stays quiet about the bound when everything fits inside it", async () => {
    seeded();
    await renderPage();

    expect(screen.queryByText(/counted as growth/)).not.toBeInTheDocument();
  });
});

describe("what the bridge deliberately is not", () => {
  it("does not list the brokerage's transactions", async () => {
    seeded();
    await renderPage();

    // The bridge is an explanation of a balance, not a feed. A dozen rows a
    // month, most of them internal, is a poor thing to read.
    expect(screen.queryByText(/DIVIDEND RECEIVED ALPHABET/)).not.toBeInTheDocument();
    expect(screen.queryByText(/REINVESTMENT FIDELITY/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Electronic Funds Transfer Received/)).not.toBeInTheDocument();
  });

  it("offers no category picker, because the tagging is automatic", async () => {
    seeded();
    await renderPage();

    expect(
      within(panel("Individual (5008)")).queryByRole("button", { name: /^Category for/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Category for DIVIDEND/ })).not.toBeInTheDocument();
  });
});

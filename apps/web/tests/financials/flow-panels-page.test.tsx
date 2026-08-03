import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClient, createBrowserClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createBrowserClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: createServerClient }));
vi.mock("@/lib/supabase/client", () => ({ createClient: createBrowserClient }));

import FinancialsOverview from "@/app/(modules)/financials/page";

/**
 * The Chase flow panel, rendered from seeded transaction and category rows.
 *
 * The point of asserting here rather than only on `buildFlowPanels` is that the
 * stats, the bars and the list are supposed to be three views of one set of
 * transactions, and that categorizing one of them writes to the database and
 * moves all three — claims only the assembled page can actually fail.
 *
 * The write is asserted as the statement it sends, not as a mocked function
 * call: what matters is that `financials_transaction.category_id` ends up
 * holding the picked category.
 */

const TODAY = new Date("2026-08-02T09:00:00Z");

type TableResult = { data: unknown[] | null; error: { message: string } | null };

/** What the browser client was asked to write, in order. */
type Write =
  | { kind: "update"; table: string; values: Record<string, unknown>; id: unknown }
  | { kind: "upsert"; table: string; values: Record<string, unknown>; onConflict?: string };

let writes: Write[] = [];
let writeError: { message: string } | null = null;

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

function stubBrowser() {
  createBrowserClient.mockReturnValue({
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq(_column: string, id: unknown) {
              writes.push({ kind: "update", table, values, id });

              return Promise.resolve({ error: writeError });
            },
          };
        },
        upsert(values: Record<string, unknown>, options?: { onConflict?: string }) {
          writes.push({ kind: "upsert", table, values, onConflict: options?.onConflict });

          return {
            select: () => ({
              single: () =>
                Promise.resolve(
                  writeError
                    ? { data: null, error: writeError }
                    : {
                        data: { id: `cat-${String(values.name).toLowerCase()}`, name: values.name },
                        error: null,
                      },
                ),
            }),
          };
        },
      };
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
  {
    id: "card",
    name: "United Explorer (3887)",
    kind: "depository",
    status: "active",
    currency: "USD",
  },
];

const categories = [
  { id: "groceries", name: "Groceries" },
  { id: "rent", name: "Rent" },
  { id: "transit", name: "Transit" },
];

function transaction(
  id: string,
  accountId: string,
  posted: string,
  description: string,
  amount: string,
  categoryId: string | null = null,
  pending = false,
) {
  return {
    id,
    account_id: accountId,
    posted: `${posted}T12:00:00+00:00`,
    description,
    amount,
    pending,
    category_id: categoryId,
  };
}

/**
 * A month of a real-shaped checking account, one card charge, one brokerage
 * dividend, and one older purchase that only a wider period reaches.
 */
const transactions = [
  transaction("t1", "chase", "2026-07-31", "PAYROLL DIRECT DEP", "3000.00"),
  transaction("t2", "chase", "2026-07-30", "RENT JULY", "-1200.00", "rent"),
  transaction("t3", "chase", "2026-07-29", "WHOLE FOODS", "-180.00", "groceries"),
  transaction("t4", "chase", "2026-07-28", "METRO TRANSIT", "-20.00", "transit"),
  transaction("t5", "chase", "2026-07-27", "CORNER SHOP", "-50.00"),
  transaction("t6", "chase", "2026-06-15", "OLD BOOKSTORE", "-60.00"),
  transaction("t7", "card", "2026-07-25", "AIRLINE TICKET", "-400.00", null, true),
  transaction("t8", "fidelity", "2026-07-30", "DIVIDEND RECEIVED", "12.00"),
];

function seeded(overrides: Partial<Record<string, TableResult>> = {}) {
  stubServer({
    financials_account: { data: accounts, error: null },
    financials_balance_snapshot: { data: [], error: null },
    financials_transaction: { data: transactions, error: null },
    financials_category: { data: categories, error: null },
    ...overrides,
  });
}

async function renderPage() {
  render(await FinancialsOverview());
}

function panel(accountName: string): HTMLElement {
  return screen.getByRole("region", { name: `Cash flow — ${accountName}` });
}

/** The figure printed under a stat's label. */
function stat(accountName: string, label: string): string {
  const term = within(panel(accountName)).getByText(label, { selector: "dt" });

  return term.nextElementSibling?.textContent ?? "";
}

/** `[category, amount]` for each expense bar, in the order they are drawn. */
function bars(accountName: string): [string, string][] {
  const region = within(panel(accountName)).getByRole("region", {
    name: `Expenses by category — ${accountName}`,
  });

  return [...region.querySelectorAll("dt")].map((term) => [
    term.textContent ?? "",
    term.nextElementSibling?.textContent ?? "",
  ]);
}

function transactionRows(accountName: string): HTMLElement[] {
  const region = within(panel(accountName)).getByRole("region", {
    name: `Transactions — ${accountName}`,
  });

  return within(region).getAllByRole("listitem");
}

/** The picker button on a transaction — its label is the category it is in. */
function categoryButton(description: string): HTMLElement {
  return screen.getByRole("button", { name: `Category for ${description}` });
}

function openPicker(description: string) {
  fireEvent.click(categoryButton(description));

  return screen.getByRole("group", { name: `Categories for ${description}` });
}

function selectPeriod(period: string) {
  fireEvent.click(
    within(screen.getByRole("group", { name: "Flow period" })).getByRole("button", {
      name: period,
    }),
  );
}

beforeEach(() => {
  createServerClient.mockReset();
  createBrowserClient.mockReset();
  writes = [];
  writeError = null;
  stubBrowser();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which accounts get a flow panel", () => {
  it("gives one to each day-to-day account", async () => {
    seeded();
    await renderPage();

    expect(panel("CHASE COLLEGE (8923)")).toBeInTheDocument();
    expect(panel("United Explorer (3887)")).toBeInTheDocument();
  });

  it("leaves the brokerage account out — its framing is the balance bridge, not flow", async () => {
    seeded();
    await renderPage();

    expect(
      screen.queryByRole("region", { name: "Cash flow — Individual (5008)" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("DIVIDEND RECEIVED")).not.toBeInTheDocument();
  });

  it("drops the whole section when nothing synced is a fit for the flow framing", async () => {
    // Only the brokerage account. An empty box below the net worth chart saying
    // there is no cash flow to show would be noise, not information.
    seeded({ financials_account: { data: [accounts[1]], error: null } });
    await renderPage();

    expect(screen.queryByRole("region", { name: "Cash flow" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Flow period" })).not.toBeInTheDocument();
  });
});

describe("the flow stats", () => {
  it("opens on the last 30 days, splitting money in from money out", async () => {
    seeded();
    await renderPage();

    expect(
      within(screen.getByRole("group", { name: "Flow period" })).getByRole("button", {
        name: "1M",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(stat("CHASE COLLEGE (8923)", "Income")).toBe("$3,000.00");
    expect(stat("CHASE COLLEGE (8923)", "Expenses")).toBe("$1,450.00");
    expect(stat("CHASE COLLEGE (8923)", "Net")).toBe("+$1,550.00");
  });

  it("reaches further back when the period widens", async () => {
    seeded();
    await renderPage();

    selectPeriod("3M");

    // The June bookstore purchase, which 1M does not reach.
    expect(stat("CHASE COLLEGE (8923)", "Expenses")).toBe("$1,510.00");
    expect(stat("CHASE COLLEGE (8923)", "Net")).toBe("+$1,490.00");
  });

  it("keeps each account's money to its own panel", async () => {
    seeded();
    await renderPage();

    expect(stat("United Explorer (3887)", "Expenses")).toBe("$400.00");
    expect(stat("United Explorer (3887)", "Net")).toBe("−$400.00");
  });

  it("traces the same net figure as a sparkline beside it", async () => {
    seeded();
    await renderPage();

    expect(
      within(panel("CHASE COLLEGE (8923)")).getByText(
        "Net flow over 30 days, ending at +$1,550.00",
      ),
    ).toBeInTheDocument();
  });

  it("says the period is empty rather than printing three zeroes", async () => {
    seeded({ financials_transaction: { data: [], error: null } });
    await renderPage();

    expect(
      within(panel("CHASE COLLEGE (8923)")).getByText("No transactions in the last 30 days."),
    ).toBeInTheDocument();
    expect(within(panel("CHASE COLLEGE (8923)")).queryByText("$0.00")).not.toBeInTheDocument();
  });
});

describe("the category bars", () => {
  it("breaks expenses down by category, largest first", async () => {
    seeded();
    await renderPage();

    expect(bars("CHASE COLLEGE (8923)")).toEqual([
      ["Rent", "$1,200.00"],
      ["Groceries", "$180.00"],
      ["Uncategorized", "$50.00"],
      ["Transit", "$20.00"],
    ]);
  });

  it("leaves income out of the breakdown", async () => {
    seeded();
    await renderPage();

    expect(bars("CHASE COLLEGE (8923)").map(([label]) => label)).not.toContain(
      "PAYROLL DIRECT DEP",
    );
    expect(
      bars("CHASE COLLEGE (8923)").reduce(
        (total, [, amount]) => total + Number(amount.slice(1).replace(/,/g, "")),
        0,
      ),
    ).toBe(1450);
  });

  it("re-sorts as the period widens", async () => {
    seeded();
    await renderPage();

    selectPeriod("3M");

    expect(bars("CHASE COLLEGE (8923)")).toEqual([
      ["Rent", "$1,200.00"],
      ["Groceries", "$180.00"],
      ["Uncategorized", "$110.00"],
      ["Transit", "$20.00"],
    ]);
  });
});

describe("the transaction list", () => {
  it("lists the period's transactions newest first", async () => {
    seeded();
    await renderPage();

    expect(transactionRows("CHASE COLLEGE (8923)").map((row) => row.textContent)).toEqual([
      expect.stringContaining("PAYROLL DIRECT DEP"),
      expect.stringContaining("RENT JULY"),
      expect.stringContaining("WHOLE FOODS"),
      expect.stringContaining("METRO TRANSIT"),
      expect.stringContaining("CORNER SHOP"),
    ]);
  });

  it("dates and signs each transaction", async () => {
    seeded();
    await renderPage();

    const [income, rent] = transactionRows("CHASE COLLEGE (8923)");

    expect(within(income).getByText("31 Jul 2026")).toBeInTheDocument();
    expect(within(income).getByText("+$3,000.00")).toBeInTheDocument();
    expect(within(rent).getByText("−$1,200.00")).toBeInTheDocument();
  });

  it("marks a transaction the bank has not settled yet", async () => {
    seeded();
    await renderPage();

    expect(
      within(transactionRows("United Explorer (3887)")[0]).getByText(/pending/),
    ).toBeInTheDocument();
  });

  it("shows each transaction's category on the row", async () => {
    seeded();
    await renderPage();

    expect(categoryButton("RENT JULY")).toHaveTextContent("Rent");
    expect(categoryButton("CORNER SHOP")).toHaveTextContent("Uncategorized");
  });
});

describe("categorizing a transaction", () => {
  it("offers every category that already exists, rather than a blank field", async () => {
    seeded();
    await renderPage();

    const picker = openPicker("CORNER SHOP");

    expect(
      within(picker)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Groceries", "Rent", "Transit"]);
  });

  it("saves the pick to the transaction, and moves the bars with it", async () => {
    seeded();
    await renderPage();

    fireEvent.click(within(openPicker("CORNER SHOP")).getByRole("button", { name: "Groceries" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      kind: "update",
      table: "financials_transaction",
      values: { category_id: "groceries" },
      id: "t5",
    });

    expect(categoryButton("CORNER SHOP")).toHaveTextContent("Groceries");
    expect(bars("CHASE COLLEGE (8923)")).toEqual([
      ["Rent", "$1,200.00"],
      ["Groceries", "$230.00"],
      ["Transit", "$20.00"],
    ]);
  });

  it("hands a newly named category back to the next transaction, rather than re-typing it", async () => {
    seeded();
    await renderPage();

    const picker = openPicker("CORNER SHOP");

    fireEvent.change(within(picker).getByRole("textbox", { name: "Find or name a category" }), {
      target: { value: "Coffee" },
    });
    fireEvent.click(within(picker).getByRole("button", { name: /Create .Coffee./ }));

    await waitFor(() => expect(categoryButton("CORNER SHOP")).toHaveTextContent("Coffee"));

    expect(writes).toEqual([
      {
        kind: "upsert",
        table: "financials_category",
        values: { name: "Coffee" },
        onConflict: "name",
      },
      {
        kind: "update",
        table: "financials_transaction",
        values: { category_id: "cat-coffee" },
        id: "t5",
      },
    ]);

    // The point of the shared table: the second transaction picks it from a list.
    expect(
      within(openPicker("METRO TRANSIT")).getByRole("button", { name: "Coffee" }),
    ).toBeInTheDocument();
  });

  it("filters the list down as a name is typed, and only offers to create what is missing", async () => {
    seeded();
    await renderPage();

    const picker = openPicker("CORNER SHOP");
    const field = within(picker).getByRole("textbox", { name: "Find or name a category" });

    fireEvent.change(field, { target: { value: "ren" } });

    expect(within(picker).getByRole("button", { name: "Rent" })).toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: "Groceries" })).not.toBeInTheDocument();
    // "ren" is not a category, so it can still be made into one.
    expect(within(picker).getByRole("button", { name: /Create .ren./ })).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "rent" } });

    expect(within(picker).queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
  });

  it("takes a transaction back out of a category", async () => {
    seeded();
    await renderPage();

    fireEvent.click(
      within(openPicker("RENT JULY")).getByRole("button", { name: "Clear category" }),
    );

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ values: { category_id: null }, id: "t2" });
    expect(categoryButton("RENT JULY")).toHaveTextContent("Uncategorized");
  });

  it("puts the row back where it was when the write is refused", async () => {
    seeded();
    await renderPage();

    writeError = { message: "permission denied" };

    fireEvent.click(within(openPicker("CORNER SHOP")).getByRole("button", { name: "Groceries" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    expect(categoryButton("CORNER SHOP")).toHaveTextContent("Uncategorized");
    expect(bars("CHASE COLLEGE (8923)")).toEqual([
      ["Rent", "$1,200.00"],
      ["Groceries", "$180.00"],
      ["Uncategorized", "$50.00"],
      ["Transit", "$20.00"],
    ]);
  });

  it("closes the picker on Escape without saving anything", async () => {
    seeded();
    await renderPage();

    const picker = openPicker("CORNER SHOP");

    fireEvent.keyDown(picker, { key: "Escape" });

    expect(
      screen.queryByRole("group", { name: "Categories for CORNER SHOP" }),
    ).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it("keeps one picker open at a time", async () => {
    seeded();
    await renderPage();

    openPicker("CORNER SHOP");
    openPicker("METRO TRANSIT");

    expect(
      screen.queryByRole("group", { name: "Categories for CORNER SHOP" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Categories for METRO TRANSIT" })).toBeInTheDocument();
  });
});

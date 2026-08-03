/**
 * Flow for a depository Account: what came in, what went out, where it went, and
 * the transactions behind it.
 *
 * Flow is the framing a checking account earns and a brokerage account doesn't
 * (spec #24–27, ADR 0003's `kind`): a balance chart says a card is at −$2,309,
 * and only a flow view says why. Everything here is derived from
 * `financials_transaction` at read time, so a panel's stats, its bars, its
 * sparkline and its list are four readings of one set of rows rather than four
 * numbers that have to be kept in step.
 *
 * SimpleFIN's sign convention is the whole basis of the split: positive is money
 * in, negative is money out (ADR 0002). Expenses are reported here as positive
 * magnitudes, because a bar chart of negative numbers reads as a bug.
 */

import { earliestDay, round, toNumber, utcDay, type TimeRange } from "@/lib/financials/day";
import type { AccountRef } from "@/lib/financials/net-worth";

/** What an uncategorized bar and an uncategorized picker entry both say. */
export const UNCATEGORIZED_LABEL = "Uncategorized";

/** The net worth account, plus the one thing a per-account figure needs that a summed one doesn't. */
export type FlowAccountRef = AccountRef & {
  /** Per account, not per page: a rewards-points account must not borrow a `$`. */
  currency?: string;
};

/** A row of `financials_category` — app-owned, shared across transactions. */
export type CategoryRef = {
  id: string;
  name: string;
};

/** Numerics arrive from PostgREST as strings; normalising is this module's job. */
export type FlowTransactionInput = {
  id: string;
  accountId: string;
  posted: string;
  description: string;
  amount: number | string;
  pending: boolean;
  categoryId: string | null;
};

export type FlowTransaction = {
  id: string;
  accountId: string;
  posted: string;
  /** The UTC day `posted` falls on, as `YYYY-MM-DD` — the unit the trend is keyed by. */
  day: string;
  description: string;
  amount: number;
  pending: boolean;
  categoryId: string | null;
  /** Resolved against the category list, so a row can render without a lookup. */
  categoryName: string | null;
};

export type FlowStats = {
  income: number;
  /** A positive magnitude — see the module note on signs. */
  expenses: number;
  net: number;
};

export type CategoryBar = {
  /** `null` is the uncategorized bucket: work still to do, not a category. */
  categoryId: string | null;
  label: string;
  amount: number;
  /** Of the period's total expenses, `0`–`1`. The bar's width, and nothing else. */
  share: number;
};

/** A day of the running net total — what the panel header's sparkline traces. */
export type FlowTrendPoint = {
  date: string;
  total: number;
};

export type FlowPanel = {
  account: FlowAccountRef;
  stats: FlowStats;
  bars: CategoryBar[];
  trend: FlowTrendPoint[];
  /** The period's transactions, newest first. */
  transactions: FlowTransaction[];
};

export type BuildFlowPanelsInput = {
  accounts: readonly FlowAccountRef[];
  transactions: readonly FlowTransactionInput[];
  categories: readonly CategoryRef[];
  period: TimeRange;
  /**
   * Required rather than defaulted, for the reason `windowSeries` requires it:
   * the caller is a client component, and reading the browser's clock here would
   * disagree with the server's render at the day boundary.
   */
  now: Date;
};

export function buildFlowPanels({
  accounts,
  transactions,
  categories,
  period,
  now,
}: BuildFlowPanelsInput): FlowPanel[] {
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const earliest = earliestDay(period, now);
  const byAccount = new Map<string, FlowTransaction[]>();

  for (const input of transactions) {
    const day = utcDay(input.posted);
    const amount = toNumber(input.amount);

    if (day === null || amount === null) continue;
    // Day strings sort lexicographically, which is why the window is one.
    if (earliest !== null && day < earliest) continue;

    const rows = byAccount.get(input.accountId) ?? [];

    rows.push({
      id: input.id,
      accountId: input.accountId,
      posted: input.posted,
      day,
      description: input.description,
      amount: round(amount),
      pending: input.pending,
      // A category id with no category behind it is treated as none at all: the
      // FK is `on delete set null`, so this is already impossible, and a row
      // labelled `undefined` would be a poor way to learn otherwise.
      categoryId: names.has(input.categoryId ?? "") ? input.categoryId : null,
      categoryName: names.get(input.categoryId ?? "") ?? null,
    });
    byAccount.set(input.accountId, rows);
  }

  return accounts
    .map((account) => panelFor(account, byAccount.get(account.id) ?? []))
    .filter(
      // A closed account keeps the history it earned (ADR 0002) and stops there.
      // Its panel is worth showing while the period still contains some of that
      // history, and is an empty box saying nothing once the window moves past.
      (panel) => panel.account.status !== "closed" || panel.transactions.length > 0,
    );
}

function panelFor(account: FlowAccountRef, rows: FlowTransaction[]): FlowPanel {
  const transactions = [...rows].sort(newestFirst);

  return {
    account,
    stats: statsFor(transactions),
    bars: barsFor(transactions),
    trend: trendFor(transactions),
    transactions,
  };
}

function statsFor(transactions: readonly FlowTransaction[]): FlowStats {
  let income = 0;
  let expenses = 0;

  for (const row of transactions) {
    if (row.amount >= 0) income += row.amount;
    else expenses += -row.amount;
  }

  // Each amount was rounded on the way in, so summing cents can only drift by
  // float noise — rounding again is what keeps `income − expenses` printable.
  income = round(income);
  expenses = round(expenses);

  return { income, expenses, net: round(income - expenses) };
}

/**
 * Expenses grouped by category, biggest first — the answer to "where did it go".
 *
 * Uncategorized spend is a bar like any other and sorts on its size like any
 * other. Pushing it to the end would make the largest unanswered question on the
 * panel the easiest thing to miss.
 */
function barsFor(transactions: readonly FlowTransaction[]): CategoryBar[] {
  const totals = new Map<string | null, { label: string; amount: number }>();
  let expenses = 0;

  for (const row of transactions) {
    if (row.amount >= 0) continue;

    const amount = -row.amount;
    const existing = totals.get(row.categoryId);

    expenses += amount;
    totals.set(row.categoryId, {
      label: existing?.label ?? row.categoryName ?? UNCATEGORIZED_LABEL,
      amount: (existing?.amount ?? 0) + amount,
    });
  }

  if (expenses === 0) return [];

  return [...totals]
    .map(([categoryId, { label, amount }]) => ({
      categoryId,
      label,
      amount: round(amount),
      share: round(amount) / round(expenses),
    }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

/**
 * Net flow accumulated across the period, one point per day that had activity.
 *
 * Cumulative rather than per-day: the last point is then the panel's own `net`
 * figure, so the sparkline is the stat's shape rather than a second calculation
 * that could disagree with it.
 */
function trendFor(transactions: readonly FlowTransaction[]): FlowTrendPoint[] {
  const byDay = new Map<string, number>();

  for (const row of transactions) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.amount);
  }

  let running = 0;

  return [...byDay.keys()].sort().map((date) => {
    running = round(running + (byDay.get(date) ?? 0));

    return { date, total: running };
  });
}

/**
 * Newest first, ties broken by id.
 *
 * A whole day's transactions routinely share one `posted` timestamp — banks post
 * in batches — and an unstable sort there would reshuffle the list on every
 * re-render, which is exactly what categorizing one row causes.
 */
function newestFirst(a: FlowTransaction, b: FlowTransaction): number {
  return b.posted.localeCompare(a.posted) || a.id.localeCompare(b.id);
}

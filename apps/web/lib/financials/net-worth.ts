/**
 * Net worth over time, derived from balance snapshots.
 *
 * Net worth is a *sum of balances at an instant*, and the only table that
 * records balances at an instant is `financials_balance_snapshot` — summing
 * transactions would drift the moment a `balance-date` led or lagged the feed
 * (ADR 0002). So the series is built here and nowhere else, and every figure the
 * overview shows — the headline, the chart, the equation strip — comes from the
 * same points, which is what makes the strip's `Chase + Fidelity = Net worth`
 * claim true rather than merely plausible.
 *
 * The unit is a UTC day, not a snapshot. Accounts are polled together but report
 * their own `balance-date`, so an instant-by-instant series would step twice a
 * day — once for each institution — and read as volatility that isn't there.
 *
 * That day, and the ranges measured in it, belong to `lib/financials/day.ts` —
 * the flow panels key off the same unit, and one definition is what keeps them
 * from drifting.
 */

import { earliestDay, round, toNumber, utcDay, type TimeRange } from "@/lib/financials/day";

/** The two states ADR 0002 gives an account. Closure is soft, and it is the user's to record. */
export type AccountStatus = "active" | "closed";

export type AccountRef = {
  id: string;
  name: string;
  /** A closed account stops contributing, see `buildNetWorthSeries`. */
  status: AccountStatus;
};

/** Numerics arrive from PostgREST as strings; normalising is this module's job, not its callers'. */
export type SnapshotInput = {
  accountId: string;
  balance: number | string;
  balanceDate: string;
};

export type NetWorthPoint = {
  /** The UTC day this point summarises, as `YYYY-MM-DD`. */
  date: string;
  total: number;
  /** What each account contributed, keyed by account id. Sums to `total`. */
  byAccount: Record<string, number>;
};

export type EquationTerm = {
  accountId: string;
  label: string;
  value: number;
};

export type NetWorthEquation = {
  terms: EquationTerm[];
  total: number;
};

export function buildNetWorthSeries({
  accounts,
  snapshots,
}: {
  accounts: readonly AccountRef[];
  snapshots: readonly SnapshotInput[];
}): NetWorthPoint[] {
  const known = new Map(accounts.map((account) => [account.id, account]));

  /** `accountId -> day -> closing balance`, last snapshot of the day winning. */
  const closingBalances = new Map<string, Map<string, number>>();
  /** The last day each account reported at all — where a closed account's history ends. */
  const lastReportedDay = new Map<string, string>();
  const days = new Set<string>();

  for (const snapshot of [...snapshots].sort(byBalanceDate)) {
    if (!known.has(snapshot.accountId)) continue;

    const day = utcDay(snapshot.balanceDate);
    const balance = toNumber(snapshot.balance);

    if (day === null || balance === null) continue;

    days.add(day);
    lastReportedDay.set(snapshot.accountId, day);

    const perDay = closingBalances.get(snapshot.accountId) ?? new Map<string, number>();

    perDay.set(day, balance);
    closingBalances.set(snapshot.accountId, perDay);
  }

  const carried = new Map<string, number>();

  return [...days].sort().map((day) => {
    const byAccount: Record<string, number> = {};
    let total = 0;

    for (const account of accounts) {
      const reported = closingBalances.get(account.id)?.get(day);

      if (reported !== undefined) carried.set(account.id, reported);

      const balance = carried.get(account.id);

      // Carrying forward is right for a poll that missed an institution, and
      // wrong forever for an account that has been closed: its balance is not
      // stale, it is gone. Closure keeps the history it earned (ADR 0002) and
      // nothing after it.
      if (balance === undefined) continue;
      if (account.status === "closed" && day > (lastReportedDay.get(account.id) ?? day)) continue;

      // Each term is rounded before it is summed, so the equation strip's terms
      // add up to the total it prints — the one claim that strip exists to make.
      const contribution = round(balance);

      byAccount[account.id] = contribution;
      total += contribution;
    }

    return { date: day, total: round(total), byAccount };
  });
}

/** The slice of the series a range toggle shows. `ALL` is every point there is. */
export function windowSeries(
  series: readonly NetWorthPoint[],
  range: TimeRange,
  now: Date,
): NetWorthPoint[] {
  const earliest = earliestDay(range, now);

  if (earliest === null) return [...series];

  // Day strings sort lexicographically, which is the whole reason for the format.
  return series.filter((point) => point.date >= earliest);
}

/**
 * The equation strip's terms: one per account contributing at `point`, in the
 * order the accounts were given, plus the total they sum to.
 *
 * One term per *account*, not per institution. Grouping by connection would read
 * closer to the `Chase + Fidelity` of the original sketch, but it hides which
 * account holds what — and the balances that matter most here are the ones that
 * disagree with their neighbours, like a card sitting negative behind the same
 * login as a checking account. The strip is the place that detail is visible
 * without leaving the page; wrapping is the layout's problem to solve.
 *
 * An account with no balance at this point is left out rather than shown as
 * zero — `Chase + Old Savings + Fidelity` with a zero in the middle claims a
 * relationship that ended.
 */
export function equationFor(
  point: NetWorthPoint | undefined,
  accounts: readonly AccountRef[],
): NetWorthEquation {
  if (!point) return { terms: [], total: 0 };

  const terms = accounts
    .filter((account) => point.byAccount[account.id] !== undefined)
    .map((account) => ({
      accountId: account.id,
      label: account.name,
      value: point.byAccount[account.id],
    }));

  return { terms, total: point.total };
}

/**
 * How far net worth moved across the window on screen — the number that makes
 * the range toggle mean something beyond zoom.
 *
 * `ratio` is null where a percentage would be a lie: one point is not a change,
 * and a rise from zero is not an infinite gain.
 */
export function changeOver(points: readonly NetWorthPoint[]): {
  absolute: number;
  ratio: number | null;
} {
  if (points.length < 2) return { absolute: 0, ratio: null };

  const opening = points[0].total;
  const closing = points[points.length - 1].total;
  const absolute = round(closing - opening);

  return { absolute, ratio: opening === 0 ? null : absolute / opening };
}

function byBalanceDate(a: SnapshotInput, b: SnapshotInput): number {
  return a.balanceDate.localeCompare(b.balanceDate);
}

import { describe, expect, it } from "vitest";

import {
  buildNetWorthSeries,
  changeOver,
  equationFor,
  windowSeries,
  type AccountRef,
  type SnapshotInput,
} from "@/lib/financials/net-worth";
import { TIME_RANGES } from "@/lib/financials/day";

const chase: AccountRef = { id: "chase", name: "Chase", status: "active" };
const fidelity: AccountRef = { id: "fidelity", name: "Fidelity", status: "active" };

function snapshot(accountId: string, day: string, balance: number | string): SnapshotInput {
  return { accountId, balanceDate: `${day}T12:00:00Z`, balance };
}

describe("buildNetWorthSeries", () => {
  it("sums every account into one point per day", () => {
    const series = buildNetWorthSeries({
      accounts: [chase, fidelity],
      snapshots: [
        snapshot("chase", "2026-08-01", 1_500),
        snapshot("fidelity", "2026-08-01", 98_500),
      ],
    });

    expect(series).toEqual([
      {
        date: "2026-08-01",
        total: 100_000,
        byAccount: { chase: 1_500, fidelity: 98_500 },
      },
    ]);
  });

  it("orders points oldest first, whatever order the rows arrived in", () => {
    const series = buildNetWorthSeries({
      accounts: [chase],
      snapshots: [
        snapshot("chase", "2026-08-03", 3),
        snapshot("chase", "2026-08-01", 1),
        snapshot("chase", "2026-08-02", 2),
      ],
    });

    expect(series.map((point) => point.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("carries an account's last balance forward through a day it did not snapshot", () => {
    // A poll that failed for one institution must not read as that account
    // dropping to zero — the other institution's snapshot still makes a day.
    const series = buildNetWorthSeries({
      accounts: [chase, fidelity],
      snapshots: [
        snapshot("chase", "2026-08-01", 1_500),
        snapshot("fidelity", "2026-08-01", 98_500),
        snapshot("fidelity", "2026-08-02", 99_000),
      ],
    });

    expect(series[1]).toEqual({
      date: "2026-08-02",
      total: 100_500,
      byAccount: { chase: 1_500, fidelity: 99_000 },
    });
  });

  it("takes the last snapshot of a day when an account was polled twice", () => {
    const series = buildNetWorthSeries({
      accounts: [chase],
      snapshots: [
        { accountId: "chase", balanceDate: "2026-08-01T06:00:00Z", balance: 100 },
        { accountId: "chase", balanceDate: "2026-08-01T20:00:00Z", balance: 250 },
      ],
    });

    expect(series).toEqual([{ date: "2026-08-01", total: 250, byAccount: { chase: 250 } }]);
  });

  it("leaves an account out of days before its first snapshot", () => {
    const series = buildNetWorthSeries({
      accounts: [chase, fidelity],
      snapshots: [
        snapshot("chase", "2026-08-01", 1_500),
        snapshot("chase", "2026-08-02", 1_500),
        snapshot("fidelity", "2026-08-02", 98_500),
      ],
    });

    expect(series[0]).toEqual({ date: "2026-08-01", total: 1_500, byAccount: { chase: 1_500 } });
  });

  it("drops a closed account after its last snapshot rather than carrying it forever", () => {
    // Closure preserves history (ADR 0002) — so the old balance still counts on
    // the days it was real, and stops counting once the account stopped
    // reporting. Carrying it forward would inflate net worth indefinitely.
    const closed: AccountRef = { id: "old", name: "Old Savings", status: "closed" };

    const series = buildNetWorthSeries({
      accounts: [chase, closed],
      snapshots: [
        snapshot("chase", "2026-08-01", 1_000),
        snapshot("old", "2026-08-01", 400),
        snapshot("chase", "2026-08-02", 1_000),
      ],
    });

    expect(series[0].total).toBe(1_400);
    expect(series[1]).toEqual({ date: "2026-08-02", total: 1_000, byAccount: { chase: 1_000 } });
  });

  it("rounds each term to cents, so the terms sum to the total exactly", () => {
    // The equation strip prints these terms next to that total and claims they
    // add up; sub-cent balances must not make it a claim off by a penny.
    const series = buildNetWorthSeries({
      accounts: [chase, fidelity],
      snapshots: [
        snapshot("chase", "2026-08-01", "1000.555"),
        snapshot("fidelity", "2026-08-01", "2000.555"),
      ],
    });

    const point = series[0];
    const summed = Object.values(point.byAccount).reduce((sum, value) => sum + value, 0);

    expect(Math.round(summed * 100) / 100).toBe(point.total);
  });

  it("reads numeric columns that arrive as strings", () => {
    const series = buildNetWorthSeries({
      accounts: [chase],
      snapshots: [snapshot("chase", "2026-08-01", "1500.50")],
    });

    expect(series[0].total).toBe(1_500.5);
  });

  it("ignores snapshots for accounts it was not given", () => {
    const series = buildNetWorthSeries({
      accounts: [chase],
      snapshots: [snapshot("chase", "2026-08-01", 100), snapshot("ghost", "2026-08-01", 999)],
    });

    expect(series[0].total).toBe(100);
  });

  it("has no series at all before the first sync", () => {
    expect(buildNetWorthSeries({ accounts: [chase], snapshots: [] })).toEqual([]);
  });
});

describe("windowSeries", () => {
  const now = new Date("2026-08-02T00:00:00Z");
  const series = buildNetWorthSeries({
    accounts: [chase],
    snapshots: [
      snapshot("chase", "2024-01-01", 10),
      snapshot("chase", "2026-01-01", 20),
      snapshot("chase", "2026-06-01", 30),
      snapshot("chase", "2026-07-25", 40),
    ],
  });

  it("keeps only the last 30 days for 1M", () => {
    expect(windowSeries(series, "1M", now).map((p) => p.date)).toEqual(["2026-07-25"]);
  });

  it("reaches back 90 days for 3M", () => {
    expect(windowSeries(series, "3M", now).map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-07-25",
    ]);
  });

  it("reaches back a year for 1Y", () => {
    expect(windowSeries(series, "1Y", now).map((p) => p.date)).toEqual([
      "2026-01-01",
      "2026-06-01",
      "2026-07-25",
    ]);
  });

  it("keeps every point for ALL", () => {
    expect(windowSeries(series, "ALL", now)).toHaveLength(4);
  });

  it("offers the four ranges the overview toggles between", () => {
    expect(TIME_RANGES).toEqual(["1M", "3M", "1Y", "ALL"]);
  });
});

describe("equationFor", () => {
  const point = {
    date: "2026-08-01",
    total: 100_000,
    byAccount: { fidelity: 98_500, chase: 1_500 },
  };

  it("names one term per contributing account, in the order the accounts are listed", () => {
    expect(equationFor(point, [chase, fidelity])).toEqual({
      terms: [
        { accountId: "chase", label: "Chase", value: 1_500 },
        { accountId: "fidelity", label: "Fidelity", value: 98_500 },
      ],
      total: 100_000,
    });
  });

  it("gives every account its own term, including two behind the same login", () => {
    // The real subscription: a card and a checking account behind the Chase
    // login, two funds behind Fidelity's. Four accounts, four terms — the card
    // sitting negative next to the checking account is exactly what would be
    // lost by folding them into one institution.
    const card: AccountRef = { id: "card", name: "United Explorer", status: "active" };
    const roth: AccountRef = { id: "roth", name: "ROTH IRA", status: "active" };

    const equation = equationFor(
      {
        date: "2026-08-01",
        total: 5_652.46,
        byAccount: { chase: 2_018.85, card: -2_309.28, fidelity: 5_334.03, roth: 608.86 },
      },
      [chase, card, fidelity, roth],
    );

    expect(equation.terms).toEqual([
      { accountId: "chase", label: "Chase", value: 2_018.85 },
      { accountId: "card", label: "United Explorer", value: -2_309.28 },
      { accountId: "fidelity", label: "Fidelity", value: 5_334.03 },
      { accountId: "roth", label: "ROTH IRA", value: 608.86 },
    ]);
    // To the cent, which is the precision the strip prints them at. Four exact
    // cent values still sum to 5652.459999999999 in binary floating point.
    const summed = equation.terms.reduce((sum, term) => sum + term.value, 0);

    expect(Math.round(summed * 100) / 100).toBe(equation.total);
  });

  it("sums its terms to the total it reports — the strip's whole claim", () => {
    const equation = equationFor(point, [chase, fidelity]);

    expect(equation.terms.reduce((sum, term) => sum + term.value, 0)).toBe(equation.total);
  });

  it("omits an account that is not contributing at this point", () => {
    const closed: AccountRef = { id: "old", name: "Old Savings", status: "closed" };

    expect(equationFor(point, [chase, fidelity, closed]).terms.map((t) => t.accountId)).toEqual([
      "chase",
      "fidelity",
    ]);
  });

  it("has nothing to equate before the first sync", () => {
    expect(equationFor(undefined, [chase, fidelity])).toEqual({ terms: [], total: 0 });
  });
});

describe("changeOver", () => {
  const point = (date: string, total: number) => ({ date, total, byAccount: { chase: total } });

  it("measures the window's first point against its last", () => {
    expect(changeOver([point("2026-07-01", 1_000), point("2026-08-01", 1_100)])).toEqual({
      absolute: 100,
      ratio: 0.1,
    });
  });

  it("reports a fall as a negative change", () => {
    expect(changeOver([point("2026-07-01", 1_000), point("2026-08-01", 900)]).absolute).toBe(-100);
  });

  it("has no percentage to report when the window opened at zero", () => {
    expect(changeOver([point("2026-07-01", 0), point("2026-08-01", 900)])).toEqual({
      absolute: 900,
      ratio: null,
    });
  });

  it("has no change to report from a single point", () => {
    expect(changeOver([point("2026-08-01", 900)])).toEqual({ absolute: 0, ratio: null });
    expect(changeOver([])).toEqual({ absolute: 0, ratio: null });
  });
});

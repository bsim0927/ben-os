import { describe, expect, it } from "vitest";

import {
  buildBridgePanels,
  tagActivity,
  type BridgeAccountRef,
  type BridgeTransactionInput,
} from "@/lib/financials/bridge";
import type { SnapshotInput } from "@/lib/financials/net-worth";

/**
 * The balance bridge's arithmetic, and the tagging that feeds it.
 *
 * The descriptions asserted below are the ones SimpleFIN's Fidelity feed
 * actually sends — copied from the synced rows, not invented — because the
 * tagging is a heuristic over provider text and a fixture made up to suit it
 * would prove nothing.
 */

const NOW = new Date("2026-08-02T09:00:00Z");

const account: BridgeAccountRef = {
  id: "fid",
  name: "Individual (5008)",
  status: "active",
  currency: "USD",
};

function snapshot(balanceDate: string, balance: string): SnapshotInput {
  return { accountId: "fid", balance, balanceDate: `${balanceDate}T08:00:00+00:00` };
}

function transaction(
  id: string,
  posted: string,
  description: string,
  amount: string,
): BridgeTransactionInput {
  return { id, accountId: "fid", posted: `${posted}T12:00:00+00:00`, description, amount };
}

/**
 * A month of real-shaped brokerage activity: cash in, a dividend and the
 * reinvestment that immediately spends it, a transfer out to another account,
 * and a fee.
 */
const snapshots = [
  snapshot("2026-07-01", "10000.00"),
  snapshot("2026-07-15", "10250.00"),
  snapshot("2026-08-01", "11000.00"),
];

const transactions = [
  transaction("t1", "2026-07-10", "Electronic Funds Transfer Received (Cash)", "-500.00"),
  transaction(
    "t2",
    "2026-07-20",
    "DIVIDEND RECEIVED ALPHABET INC CAP STK CL A (GOOGL) (Cash)",
    "25.00",
  ),
  transaction(
    "t3",
    "2026-07-20",
    "REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)",
    "-25.00",
  ),
  transaction(
    "t4",
    "2026-07-25",
    "TRANSFERRED TO VS XXX-XXX715-1 CURRENT CONTRIBUTION (Cash)",
    "-100.00",
  ),
  transaction("t5", "2026-07-28", "ADVISORY FEE (Cash)", "-15.00"),
];

function bridgeFor(period: "1M" | "3M" | "1Y" | "ALL" = "ALL") {
  const [panel] = buildBridgePanels({
    accounts: [account],
    transactions,
    snapshots,
    period,
    now: NOW,
  });

  return panel.bridge;
}

/** `kind -> value`, which is what every assertion about the bridge is about. */
function values(period: "1M" | "3M" | "1Y" | "ALL" = "ALL"): Record<string, number> {
  const bridge = bridgeFor(period);

  if (!bridge) throw new Error("expected a bridge");

  return Object.fromEntries(bridge.segments.map((segment) => [segment.kind, segment.value]));
}

describe("tagging Fidelity activity", () => {
  it("recognises a dividend", () => {
    expect(tagActivity("DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)")).toBe(
      "dividend",
    );
    expect(tagActivity("DIVIDEND RECEIVED CHEVRON CORP NEW COM (CVX) (Cash)")).toBe("dividend");
  });

  it("recognises cash arriving, whichever way the feed words it", () => {
    expect(tagActivity("Electronic Funds Transfer Received (Cash)")).toBe("contribution");
    expect(tagActivity("CASH CONTRIBUTION CURRENT YEAR (Cash)")).toBe("contribution");
  });

  it("recognises cash leaving, even though the row also says CONTRIBUTION", () => {
    // The transfer that funds the Roth is worded as a contribution *to the other
    // account*; reading the word alone would count money leaving as money in.
    expect(tagActivity("TRANSFERRED TO VS XXX-XXX715-1 CURRENT CONTRIBUTION (Cash)")).toBe(
      "withdrawal",
    );
  });

  it("recognises a fee", () => {
    expect(tagActivity("ADVISORY FEE (Cash)")).toBe("fee");
    expect(tagActivity("SHORT TERM TRADING FEE (Cash)")).toBe("fee");
  });

  it("leaves an internal reallocation untagged, so it never lands in a segment", () => {
    // Buying a fund with the dividend that just arrived moves cash into shares
    // inside the same account. Its value did not change, and counting the cash
    // leg would understate growth by the whole dividend.
    expect(tagActivity("REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)")).toBeNull();
    expect(tagActivity("YOU BOUGHT ALPHABET INC CAP STK CL A (GOOGL) (Cash)")).toBeNull();
    expect(tagActivity("YOU SOLD CHEVRON CORP NEW COM (CVX) (Cash)")).toBeNull();
  });
});

describe("the bridge's segments", () => {
  it("opens and closes on the real balances either end of the window", () => {
    expect(values()).toMatchObject({ start: 10000, end: 11000 });
    expect(bridgeFor()?.delta).toBe(1000);
  });

  it("takes contributions as a net, so a transfer out is not counted as money in", () => {
    // +500 in, −100 out to the Roth.
    expect(values().contributions).toBe(400);
  });

  it("counts the dividend once, not against the reinvestment that spent it", () => {
    expect(values().dividends).toBe(25);
  });

  it("reports fees as the negative they are", () => {
    expect(values().fees).toBe(-15);
  });

  it("leaves growth as whatever the tagged activity does not explain", () => {
    // 1000 delta − 400 contributions − 25 dividends + 15 fees.
    expect(values().growth).toBe(590);
  });

  it("reconciles exactly to the balance delta, which is the whole point", () => {
    const bridge = bridgeFor();

    if (!bridge) throw new Error("expected a bridge");

    const explained = bridge.segments
      .filter((segment) => !segment.total)
      .reduce((sum, segment) => sum + segment.value, 0);

    expect(bridge.start + explained).toBe(bridge.end);
  });

  it("carries a running balance each segment can be drawn against", () => {
    expect(
      bridgeFor()?.segments.map((segment) => [segment.kind, segment.from, segment.to]),
    ).toEqual([
      ["start", 0, 10000],
      ["contributions", 10000, 10400],
      ["dividends", 10400, 10425],
      ["growth", 10425, 11015],
      ["fees", 11015, 11000],
      ["end", 0, 11000],
    ]);
  });
});

describe("the period the bridge covers", () => {
  it("moves its start balance forward when the period narrows", () => {
    // 1M reaches back to 3 July, so the 1 July snapshot is outside it and the
    // 15 July one opens the window.
    expect(values("1M")).toMatchObject({ start: 10250, end: 11000 });
  });

  it("counts only the activity inside that narrower window", () => {
    // The 10 July contribution is now before the start balance, which already
    // contains it. Counting it again would take it straight back out of growth.
    expect(values("1M")).toMatchObject({
      contributions: -100,
      dividends: 25,
      fees: -15,
      growth: 840,
    });
  });

  it("still reconciles once the window has moved", () => {
    const bridge = bridgeFor("1M");

    if (!bridge) throw new Error("expected a bridge");

    const explained = bridge.segments
      .filter((segment) => !segment.total)
      .reduce((sum, segment) => sum + segment.value, 0);

    expect(bridge.start + explained).toBe(bridge.end);
  });
});

describe("when there is not enough history to explain anything", () => {
  it("offers no bridge from a single balance reading", () => {
    // Balance history accrues one point per sync and cannot be backfilled, so a
    // freshly linked account genuinely has nothing to bridge between. A bridge
    // of zeroes would claim the balance had not moved.
    const [panel] = buildBridgePanels({
      accounts: [account],
      transactions,
      snapshots: [snapshots[2]],
      period: "ALL",
      now: NOW,
    });

    expect(panel.bridge).toBeNull();
  });

  it("offers no bridge when the period reaches back past every reading", () => {
    const [panel] = buildBridgePanels({
      accounts: [account],
      transactions,
      snapshots: [snapshot("2026-01-01", "9000.00"), snapshot("2026-01-02", "9100.00")],
      period: "1M",
      now: NOW,
    });

    expect(panel.bridge).toBeNull();
  });
});

describe("which accounts get a panel", () => {
  it("keeps an active account even with nothing to bridge, so the panel can say so", () => {
    const panels = buildBridgePanels({
      accounts: [account],
      transactions: [],
      snapshots: [],
      period: "ALL",
      now: NOW,
    });

    expect(panels).toHaveLength(1);
    expect(panels[0].bridge).toBeNull();
  });

  it("drops a closed account once the period has moved past its history", () => {
    const closed: BridgeAccountRef = { ...account, id: "old", status: "closed" };
    const panels = buildBridgePanels({
      accounts: [closed],
      transactions: [],
      snapshots: [],
      period: "ALL",
      now: NOW,
    });

    expect(panels).toEqual([]);
  });

  it("keeps a closed account while the period still contains its history", () => {
    const closed: BridgeAccountRef = { ...account, status: "closed" };
    const panels = buildBridgePanels({
      accounts: [closed],
      transactions,
      snapshots,
      period: "ALL",
      now: NOW,
    });

    expect(panels[0].bridge?.end).toBe(11000);
  });

  it("keeps each account's activity to its own bridge", () => {
    const other: BridgeAccountRef = { ...account, id: "roth", name: "ROTH IRA (3715)" };
    const panels = buildBridgePanels({
      accounts: [account, other],
      transactions,
      snapshots: [
        ...snapshots,
        { accountId: "roth", balance: "2000.00", balanceDate: "2026-07-01T08:00:00+00:00" },
        { accountId: "roth", balance: "2600.00", balanceDate: "2026-08-01T08:00:00+00:00" },
      ],
      period: "ALL",
      now: NOW,
    });

    // None of the Individual account's transactions are the Roth's, so all 600
    // of its rise is unexplained.
    expect(panels[1].bridge).toMatchObject({ start: 2000, end: 2600 });
    expect(panels[1].bridge?.segments.find((segment) => segment.kind === "growth")?.value).toBe(
      600,
    );
  });
});

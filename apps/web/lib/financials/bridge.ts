/**
 * The balance bridge for an investment Account: why the balance moved, not just
 * that it moved.
 *
 * The counterpart to Flow (spec #30–32, ADR 0003's `kind`). A brokerage's
 * transaction feed is a poor list to read — a dozen rows a month, most of them
 * internal — but it is a good *explanation* of a balance that moved by
 * thousands. So this is built as a bridge rather than a list: Start,
 * Contributions, Dividends, Growth, Fees, End.
 *
 * Two tables, doing different jobs. `financials_balance_snapshot` supplies the
 * two ends, because it is the only thing that records what the account was
 * actually worth (ADR 0002 — summing transactions drifts the moment a
 * `balance-date` leads or lags the feed). `financials_transaction` supplies the
 * middle, but only the part of it that can be attributed.
 *
 * **Growth is the residual**, and that is a correctness property rather than a
 * shortcut. Market movement has no transaction to sum: nothing posts when a
 * holding rises. Deriving growth as the unexplained remainder makes the bridge
 * reconcile to the real balance delta by construction — so a tagging rule that
 * misses a row shifts money between two segments and never makes the total
 * wrong. That is the failure mode worth having, because the tagging is a
 * heuristic over provider text and will meet a wording it does not know.
 */

import { earliestDay, round, toNumber, utcDay, type TimeRange } from "@/lib/financials/day";
import {
  closingBalancesByDay,
  type AccountRef,
  type SnapshotInput,
} from "@/lib/financials/net-worth";

/**
 * What a row of brokerage activity turns out to be, or `null` for the rows that
 * are none of these.
 *
 * `null` is the common case and the right one: a reinvestment, a buy or a sell
 * moves value *within* the account, so it changes no balance and belongs in no
 * segment. Growth being a residual is what lets them simply be ignored rather
 * than needing a segment of their own that would always sum to zero.
 */
export type ActivityTag = "contribution" | "withdrawal" | "dividend" | "fee" | null;

/** The net worth account, plus the currency a per-account figure has to print in. */
export type BridgeAccountRef = AccountRef & {
  currency?: string;
};

/** Numerics arrive from PostgREST as strings; normalising is this module's job. */
export type BridgeTransactionInput = {
  id: string;
  accountId: string;
  posted: string;
  description: string;
  amount: number | string;
};

export type BridgeSegmentKind = "start" | "contributions" | "dividends" | "growth" | "fees" | "end";

export type BridgeSegment = {
  kind: BridgeSegmentKind;
  label: string;
  /** A balance for the two totals, a signed change for the four in between. */
  value: number;
  /** The running balance either side of this segment — a bar's foot and head. */
  from: number;
  to: number;
  /** A balance rather than a change: drawn from the axis, not floating. */
  total: boolean;
};

export type BalanceBridge = {
  /** The UTC day the opening balance closed on. */
  startDay: string;
  endDay: string;
  start: number;
  end: number;
  /** `end − start`, which the four middle segments sum to exactly. */
  delta: number;
  /** Always the six segments, in the order they are drawn. */
  segments: BridgeSegment[];
};

export type BridgePanel = {
  account: BridgeAccountRef;
  /** `null` where the window holds fewer than two balance readings. */
  bridge: BalanceBridge | null;
};

export type BuildBridgePanelsInput = {
  accounts: readonly BridgeAccountRef[];
  transactions: readonly BridgeTransactionInput[];
  snapshots: readonly SnapshotInput[];
  period: TimeRange;
  /** Required for the reason `buildFlowPanels` requires it: the caller is a client component. */
  now: Date;
};

/**
 * Rows that move value inside the account without changing what it is worth.
 *
 * Checked before anything else, because these are the descriptions most likely
 * to also carry a word another rule wants. A reinvested dividend posts twice —
 * `DIVIDEND RECEIVED …` and `REINVESTMENT …` — and counting the second as
 * anything at all would take the first straight back out.
 */
const INTERNAL = /reinvest|you bought|you sold|\b(?:bought|sold|purchase|redemption)\b/i;

/** Fees are unambiguous in a way the transfer rows are not, so they go first. */
const FEE = /\bfees?\b|service charge|commission/i;

/**
 * Payouts from a holding — income, whichever word the fund uses for it.
 *
 * `cap gain` earns its place ahead of `WITHDRAWAL`: Fidelity's year-end wording
 * is `LONG-TERM CAP GAIN DISTRIBUTION`, and `distribution` is also what a
 * retirement account calls money going *out*. Checked here, the payout is income
 * and the bare `DISTRIBUTION` below is still a withdrawal.
 */
const DIVIDEND = /\bdividends?\b|interest earned|\bcap(?:ital)? gain\b/i;

/**
 * Cash leaving the account, checked before the inbound rule rather than after.
 *
 * `TRANSFERRED TO VS XXX-XXX715-1 CURRENT CONTRIBUTION` is the transfer that
 * funds the Roth: it is worded as a contribution because it is one — to the
 * *other* account. Matching on the word alone would count money leaving as
 * money arriving, and put double its value into the wrong side of the bridge.
 *
 * `sent` is here for the same reason in the opposite direction. `CONTRIBUTION`
 * matches a bare `electronic funds transfer`, which is the only wording the feed
 * has sent so far — but it is the inbound half of a pair, and the outbound half
 * would otherwise be counted as money arriving.
 */
const WITHDRAWAL = /transferred to|withdrawal|distribution|\bsent\b|\bpaid out\b/i;

const CONTRIBUTION = /contribution|transferred from|electronic funds transfer|deposit/i;

/**
 * What a row of activity is, from the only thing SimpleFIN gives us to go on.
 *
 * The description and nothing else — deliberately, because **the amount's sign
 * cannot be trusted on this feed**. SimpleFIN's convention is positive-in,
 * negative-out (ADR 0002) and the Chase rows honour it, but Fidelity's do not:
 * a $2,400 transfer *into* the brokerage posts as `Electronic Funds Transfer
 * Received` at −2400.00 on the same day Chase posts −2400.00 sending it. Both
 * legs of the Individual→Roth transfer post negative too, so the sign does not
 * even distinguish the two ends of one movement. Reading direction off the tag
 * and magnitude off `|amount|` is the only reading the data supports.
 */
export function tagActivity(description: string): ActivityTag {
  if (INTERNAL.test(description)) return null;
  if (FEE.test(description)) return "fee";
  if (DIVIDEND.test(description)) return "dividend";
  if (WITHDRAWAL.test(description)) return "withdrawal";
  if (CONTRIBUTION.test(description)) return "contribution";

  return null;
}

export function buildBridgePanels({
  accounts,
  transactions,
  snapshots,
  period,
  now,
}: BuildBridgePanelsInput): BridgePanel[] {
  const earliest = earliestDay(period, now);
  const balances = closingBalancesByDay(snapshots);
  const byAccount = new Map<string, BridgeTransactionInput[]>();

  for (const input of transactions) {
    const rows = byAccount.get(input.accountId) ?? [];

    rows.push(input);
    byAccount.set(input.accountId, rows);
  }

  return accounts
    .map((account) => ({
      account,
      bridge: bridgeFor(
        balances.get(account.id) ?? new Map(),
        byAccount.get(account.id) ?? [],
        earliest,
      ),
    }))
    .filter(
      // An active account with nothing to bridge keeps its panel, which has
      // words for that; a closed one whose history the period has moved past is
      // an empty box about an account that no longer exists.
      (panel) => panel.account.status !== "closed" || panel.bridge !== null,
    );
}

function bridgeFor(
  balances: Map<string, number>,
  transactions: readonly BridgeTransactionInput[],
  earliest: string | null,
): BalanceBridge | null {
  // Day strings sort lexicographically, which is the point of the format.
  const days = [...balances.keys()].sort().filter((day) => earliest === null || day >= earliest);

  // One reading is a balance, not a change. Balance history accrues a point per
  // sync and cannot be backfilled, so this is the honest state of a freshly
  // linked account rather than an edge case — and a bridge of zeroes drawn
  // across it would claim the balance had stood still.
  if (days.length < 2) return null;

  // Both days came out of `balances`'s own keys, so neither lookup can miss.
  const startDay = days[0];
  const endDay = days[days.length - 1];
  const start = round(balances.get(startDay) as number);
  const end = round(balances.get(endDay) as number);
  const delta = round(end - start);

  let contributions = 0;
  let dividends = 0;
  let fees = 0;

  for (const input of transactions) {
    const day = utcDay(input.posted);
    const amount = toNumber(input.amount);

    if (day === null || amount === null) continue;
    // Strictly after the opening day: `start` is that day's *closing* balance,
    // so activity on it is already inside the figure. Counting it again would
    // take its value straight back out of growth.
    if (day <= startDay || day > endDay) continue;

    // Magnitude from the amount, direction from the tag — see `tagActivity`.
    const magnitude = Math.abs(amount);

    switch (tagActivity(input.description)) {
      case "contribution":
        contributions += magnitude;
        break;
      case "withdrawal":
        contributions -= magnitude;
        break;
      case "dividend":
        dividends += magnitude;
        break;
      case "fee":
        fees -= magnitude;
        break;
    }
  }

  contributions = round(contributions);
  dividends = round(dividends);
  fees = round(fees);

  // The residual, and the reason the bridge reconciles rather than merely
  // tending to. Rounded from the already-rounded parts so the segments print as
  // money that adds up.
  const growth = round(delta - contributions - dividends - fees);

  return {
    startDay,
    endDay,
    start,
    end,
    delta,
    segments: segmentsFor({ start, end, contributions, dividends, growth, fees }),
  };
}

function segmentsFor({
  start,
  end,
  contributions,
  dividends,
  growth,
  fees,
}: {
  start: number;
  end: number;
  contributions: number;
  dividends: number;
  growth: number;
  fees: number;
}): BridgeSegment[] {
  // Fees last of the four, so the bridge lands on `end` after the deduction
  // rather than before it — a bridge that closed on a figure the account never
  // held would be a strange thing to read.
  const changes: { kind: BridgeSegmentKind; label: string; value: number }[] = [
    { kind: "contributions", label: "Contributions", value: contributions },
    { kind: "dividends", label: "Dividends", value: dividends },
    { kind: "growth", label: "Growth", value: growth },
    { kind: "fees", label: "Fees", value: fees },
  ];

  let running = start;
  const middle = changes.map(({ kind, label, value }) => {
    const from = running;

    running = round(running + value);

    return { kind, label, value, from, to: running, total: false };
  });

  return [
    { kind: "start", label: "Start", value: start, from: 0, to: start, total: true },
    ...middle,
    { kind: "end", label: "End", value: end, from: 0, to: end, total: true },
  ];
}

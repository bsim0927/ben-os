"use client";

import { useMemo, useState } from "react";

import { MicroLabel, SegmentedToggle } from "@/components/console";
import { waterfallGeometry, type WaterfallBar } from "@/lib/chart";
import {
  buildBridgePanels,
  type BalanceBridge,
  type BridgeAccountRef,
  type BridgePanel,
  type BridgeSegment,
  type BridgeTransactionInput,
} from "@/lib/financials/bridge";
import { rangeLabel, TIME_RANGES, type TimeRange } from "@/lib/financials/day";
import {
  formatAmount,
  formatCompactAmount,
  formatDay,
  formatSignedAmount,
} from "@/lib/financials/format";
import type { SnapshotInput } from "@/lib/financials/net-worth";

/**
 * The balance bridge panels: one per investment Account, saying why the balance
 * moved rather than listing the rows it moved through.
 *
 * A client component only so the period toggle resolves without a round trip —
 * unlike the flow panels there is nothing to write here, which is the point.
 * Brokerage activity is auto-tagged from its description (spec #32), so there is
 * no category picker on this account and nothing to save.
 *
 * `today` is passed in rather than read from the clock, for the reason every
 * other period on this page takes it: the server and the client have to agree on
 * where the window starts, and `new Date()` here would disagree at midnight.
 */

const WIDTH = 960;
const HEIGHT = 260;
/** Left for the axis labels, bottom for the column names, top for the value above each bar. */
const PADDING = { top: 26, right: 12, bottom: 46, left: 68 };
const GAP = 28;

export type BridgePanelsProps = {
  /** Investment accounts only — a checking account gets flow, not this. */
  accounts: readonly BridgeAccountRef[];
  transactions: readonly BridgeTransactionInput[];
  snapshots: readonly SnapshotInput[];
  /** ISO timestamp the periods are measured back from. */
  today: string;
};

export function BridgePanels({ accounts, transactions, snapshots, today }: BridgePanelsProps) {
  const [period, setPeriod] = useState<TimeRange>("1M");

  const panels = useMemo(
    () => buildBridgePanels({ accounts, transactions, snapshots, period, now: new Date(today) }),
    [accounts, transactions, snapshots, period, today],
  );

  // No panels, no section — the same rule the flow panels follow. This only ever
  // means "nothing synced here is a fit for the bridge framing", because an
  // account with too little history keeps its panel and says so itself.
  if (panels.length === 0) return null;

  return (
    <section aria-label="Balance bridge" className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <MicroLabel as="h2">Balance bridge</MicroLabel>
          <p className="text-muted mt-1 text-[13px]">
            What moved each brokerage balance — contributions and dividends in, fees out, and market
            growth as whatever is left over.
          </p>
        </div>

        <SegmentedToggle
          label="Bridge period"
          options={TIME_RANGES}
          selected={period}
          onChange={setPeriod}
        />
      </header>

      <div className="flex flex-col gap-4">
        {panels.map((panel) => (
          <AccountPanel key={panel.account.id} panel={panel} period={period} />
        ))}
      </div>
    </section>
  );
}

function AccountPanel({ panel, period }: { panel: BridgePanel; period: TimeRange }) {
  const { account, bridge } = panel;

  return (
    <section
      aria-label={`Balance bridge — ${account.name}`}
      className="border-hairline bg-panel rounded-md border"
    >
      <header className="border-hairline flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <MicroLabel as="h3">{account.name}</MicroLabel>
        {bridge ? (
          <span
            className={`text-[13px] tabular-nums ${bridge.delta < 0 ? "text-negative" : "text-positive"}`}
          >
            {formatSignedAmount(bridge.delta, account.currency)} over {rangeLabel(period)}
          </span>
        ) : null}
      </header>

      {bridge ? (
        <BridgeChart bridge={bridge} currency={account.currency} accountName={account.name} />
      ) : (
        /*
         * Not a bridge of zeroes: the balance has not stood still, we simply
         * cannot yet say what it did. Balance history accrues one reading per
         * sync and cannot be backfilled, so this is what a newly linked account
         * looks like rather than a fault.
         */
        <p className="text-muted px-4 py-10 text-center text-[13px]">
          {period === "ALL"
            ? "Only one balance reading so far — a bridge needs two, so there is no change to explain yet. History fills in from each sync."
            : `No two balance readings in the last ${rangeLabel(period)} — try a wider period.`}
        </p>
      )}
    </section>
  );
}

/**
 * The waterfall itself: totals standing on the axis at either end, the four
 * changes floating between them.
 *
 * The SVG is `aria-hidden` and the same figures are repeated as a
 * visually-hidden table, the way the net worth chart does it. A chart that
 * exists only as `<rect>`s is unreadable to a screen reader and unassertable in
 * a test, and one honest text alternative fixes both.
 */
function BridgeChart({
  bridge,
  currency,
  accountName,
}: {
  bridge: BalanceBridge;
  currency?: string;
  accountName: string;
}) {
  const { bars, connectors, gridlines, floor } = waterfallGeometry({
    bars: bridge.segments,
    width: WIDTH,
    height: HEIGHT,
    padding: PADDING,
    gap: GAP,
  });

  const period = `${formatDay(bridge.startDay)} to ${formatDay(bridge.endDay)}`;

  return (
    <figure className="m-0 px-4 py-4">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {gridlines.map((gridline) => (
          <g key={gridline.value}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={gridline.y}
              y2={gridline.y}
              className="stroke-hairline"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 10}
              y={gridline.y + 4}
              textAnchor="end"
              fontSize={12}
              className="fill-muted tabular-nums"
            >
              {formatCompactAmount(gridline.value, currency)}
            </text>
          </g>
        ))}

        {connectors.map((connector, index) => (
          <line
            key={index}
            x1={connector.x1}
            x2={connector.x2}
            y1={connector.y}
            y2={connector.y}
            className="stroke-muted"
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.6}
          />
        ))}

        {bars.map((bar, index) => {
          const segment = bridge.segments[index];

          return (
            <g key={segment.kind}>
              <rect
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx={2}
                className={fillFor(bar)}
              />
              {/* Above the bar, because the height is a magnitude and the sign
                  is half of what the segment says. */}
              <text
                x={bar.x + bar.width / 2}
                y={bar.y - 8}
                textAnchor="middle"
                fontSize={12}
                className="fill-ink tabular-nums"
              >
                {renderSegment(segment, currency)}
              </text>
              <text
                x={bar.x + bar.width / 2}
                y={floor + 20}
                textAnchor="middle"
                fontSize={12}
                className="fill-muted"
              >
                {segment.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/*
       * `sr-only` on the wrapper rather than the table: a `<caption>` box is
       * generated outside the table grid, so the clipping `sr-only` puts on a
       * table never reaches it and the caption renders over the chart.
       */}
      <div className="sr-only">
        <table>
          <caption>{`Balance bridge for ${accountName}, ${period}`}</caption>
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bridge.segments.map((segment) => (
              <tr key={segment.kind}>
                <th scope="row">{segment.label}</th>
                <td>{renderSegment(segment, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
       * Said out loud, because a reader is owed the difference between a figure
       * that was measured and one that is whatever the measured ones did not
       * account for.
       */}
      <figcaption className="text-muted mt-2 text-[12px]">
        {period}. Growth is the residual — whatever the tagged activity does not explain — so the
        bridge always reconciles to the balance change.
      </figcaption>
    </figure>
  );
}

/**
 * How a segment's figure prints.
 *
 * A change carries its sign, because `+$400.00` and `−$400.00` are the opposite
 * claims and the bar's height says neither. A total is a balance and has no
 * direction to report — and neither does a change of nothing, which is why a
 * period with no fees reads `$0.00` rather than the `+$0.00` a signed formatter
 * would give it.
 */
function renderSegment(segment: BridgeSegment, currency?: string): string {
  return segment.total || segment.value === 0
    ? formatAmount(segment.value, currency)
    : formatSignedAmount(segment.value, currency);
}

/** Totals are the accent the page uses for balances; changes read as gain or loss. */
function fillFor(bar: WaterfallBar): string {
  if (bar.direction === "total") return "fill-accent";
  if (bar.direction === "up") return "fill-positive";
  if (bar.direction === "down") return "fill-negative";

  return "fill-muted";
}

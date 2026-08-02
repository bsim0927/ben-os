"use client";

import { Fragment, useMemo, useState } from "react";

import { AreaChart } from "@/components/area-chart";
import { MicroLabel } from "@/components/console";
import {
  formatAmount,
  formatCompactAmount,
  formatDay,
  formatPercent,
  formatSignedAmount,
} from "@/lib/financials/format";
import {
  changeOver,
  equationFor,
  NET_WORTH_RANGES,
  windowSeries,
  type AccountRef,
  type NetWorthPoint,
  type NetWorthRange,
} from "@/lib/financials/net-worth";

/**
 * The Financials overview's hero: net worth as a trend, and the equation that
 * says where the number came from.
 *
 * A client component because the range toggle is the one interactive thing on
 * the page, and the whole series is already here — re-fetching from the server
 * to hide points the browser is holding would make a zoom control cost a round
 * trip.
 *
 * `today` is passed in rather than read from the clock so the server and client
 * renders agree on where each window starts; `new Date()` here would be a
 * hydration mismatch waiting for midnight.
 */

export type NetWorthHeroProps = {
  accounts: readonly AccountRef[];
  /** The full series, oldest first. Windowing happens here, per range. */
  series: readonly NetWorthPoint[];
  /** ISO timestamp the windows are measured back from. */
  today: string;
  /** Shared across accounts, or undefined when they disagree. */
  currency?: string;
};

export function NetWorthHero({ accounts, series, today, currency }: NetWorthHeroProps) {
  const [range, setRange] = useState<NetWorthRange>("3M");

  const windowed = useMemo(
    () => windowSeries(series, range, new Date(today)),
    [series, range, today],
  );

  const latest = windowed[windowed.length - 1];
  const equation = equationFor(latest, accounts);
  const change = changeOver(windowed);

  if (series.length === 0) {
    return (
      <section>
        <MicroLabel as="h1">Net worth</MicroLabel>
        <p className="border-hairline text-muted mt-3 border-t pt-3 text-[13px]">
          No balance snapshots yet — net worth appears once the scheduled SimpleFIN poll has run at
          least once.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <MicroLabel as="h1">Net worth</MicroLabel>
          <p className="text-ink mt-1 text-[32px] leading-none font-medium tabular-nums">
            {formatAmount(equation.total, currency)}
          </p>
          <p className="text-muted mt-2 text-[13px]">
            {windowed.length < 2 ? (
              <>Not enough history yet to show a change over {rangeLabel(range)}.</>
            ) : (
              <>
                <span
                  className={`tabular-nums ${change.absolute < 0 ? "text-negative" : "text-positive"}`}
                >
                  {formatSignedAmount(change.absolute, currency)}
                </span>
                {change.ratio === null ? null : (
                  <span className="tabular-nums"> ({formatPercent(change.ratio)})</span>
                )}{" "}
                over {rangeLabel(range)}
              </>
            )}
          </p>
        </div>

        <RangeToggle range={range} onChange={setRange} />
      </header>

      <div className="border-hairline bg-panel rounded-md border p-4">
        <AreaChart
          data={windowed.map((point) => ({ x: dayToX(point.date), y: point.total }))}
          caption={`Net worth by day, ${rangeLabel(range)}`}
          valueLabel="Net worth"
          formatValue={(value) => formatAmount(value, currency)}
          formatTick={(value) => formatCompactAmount(value, currency)}
          formatX={(x) => formatDay(xToDay(x))}
        />
      </div>

      <EquationStrip equation={equation} asOf={latest?.date} currency={currency} />
    </section>
  );
}

function RangeToggle({
  range,
  onChange,
}: {
  range: NetWorthRange;
  onChange: (next: NetWorthRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Chart range"
      className="border-hairline bg-panel-2 flex overflow-hidden rounded-md border"
    >
      {NET_WORTH_RANGES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === range}
          onClick={() => onChange(option)}
          className={`border-hairline px-3 py-1.5 text-[12px] tracking-[0.04em] not-first:border-l ${
            option === range ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/**
 * `Chase + Fidelity = Net worth`, with the figures.
 *
 * Its whole job is to say that net worth is a sum of the accounts rather than a
 * separately computed number, so the terms are read off the same point the chart
 * ends on — they cannot drift from it.
 */
function EquationStrip({
  equation,
  asOf,
  currency,
}: {
  equation: ReturnType<typeof equationFor>;
  asOf: string | undefined;
  currency?: string;
}) {
  if (equation.terms.length === 0) return null;

  return (
    <section aria-label="Net worth equation" className="border-hairline border-t pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-3">
        {equation.terms.map((term, index) => (
          <Fragment key={term.accountId}>
            {index > 0 ? <Operator>+</Operator> : null}
            <Term label={term.label} value={formatAmount(term.value, currency)} />
          </Fragment>
        ))}
        <Operator>=</Operator>
        <Term label="Net worth" value={formatAmount(equation.total, currency)} emphasised />
      </div>
      {asOf ? <p className="text-muted mt-3 text-[12px]">As of {formatDay(asOf)}</p> : null}
    </section>
  );
}

function Term({
  label,
  value,
  emphasised = false,
}: {
  label: string;
  value: string;
  emphasised?: boolean;
}) {
  return (
    <span className="flex flex-col gap-1">
      <MicroLabel as="h3">{label}</MicroLabel>
      <span
        className={`tabular-nums ${emphasised ? "text-ink text-[15px] font-medium" : "text-ink text-[15px]"}`}
      >
        {value}
      </span>
    </span>
  );
}

function Operator({ children }: { children: React.ReactNode }) {
  return <span className="text-muted pt-4 text-[15px]">{children}</span>;
}

function rangeLabel(range: NetWorthRange): string {
  return { "1M": "1 month", "3M": "3 months", "1Y": "1 year", ALL: "all time" }[range];
}

/**
 * Days as milliseconds, so the chart spaces points by real elapsed time and a
 * poll the sync missed reads as the gap it was.
 */
function dayToX(day: string): number {
  return new Date(`${day}T00:00:00Z`).getTime();
}

function xToDay(x: number): string {
  return new Date(x).toISOString().slice(0, 10);
}

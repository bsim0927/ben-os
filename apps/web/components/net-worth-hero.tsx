"use client";

import { useMemo, useState } from "react";

import { AreaChart } from "@/components/area-chart";
import { MicroLabel, SegmentedToggle } from "@/components/console";
import {
  formatAmount,
  formatCompactAmount,
  formatDay,
  formatPercent,
  formatSignedAmount,
} from "@/lib/financials/format";
import {
  dayToTimestamp,
  rangeLabel,
  timestampToDay,
  TIME_RANGES,
  type TimeRange,
} from "@/lib/financials/day";
import {
  changeOver,
  equationFor,
  windowSeries,
  type AccountRef,
  type NetWorthEquation,
  type NetWorthPoint,
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
  const [range, setRange] = useState<TimeRange>("3M");

  const windowed = useMemo(
    () => windowSeries(series, range, new Date(today)),
    [series, range, today],
  );

  // Off the *full* series, not the window. Every non-empty window ends on the
  // latest point anyway — but a window can be empty (sync broken for longer than
  // the range, or an account newer than it), and reading the headline off an
  // empty window would print a confident $0.00 for money that is still there.
  const latest = series[series.length - 1];
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

        <SegmentedToggle
          label="Chart range"
          options={TIME_RANGES}
          selected={range}
          onChange={setRange}
        />
      </header>

      <div className="border-hairline bg-panel rounded-md border p-4">
        {windowed.length === 0 ? (
          // The balances below are still the latest known ones; it is this
          // window that has nothing in it, and saying so beats an empty box.
          <ChartNotice
            headline={`No balance readings in the last ${rangeLabel(range)}.`}
            detail="The figures below are the most recent ones on record."
          />
        ) : windowed.length === 1 ? (
          // One reading is not a trend, and drawing it as a lone dot on an empty
          // grid reads as a broken chart rather than as a new account. Balance
          // history cannot be backfilled — SimpleFIN serves the current balance
          // only — so this state is every account's first day, and it should say
          // what happens next rather than look like a failure.
          <ChartNotice
            headline={`One balance reading so far, from ${formatDay(windowed[0].date)}.`}
            detail="Net worth history builds up one point per sync — the trend line appears after the next daily poll."
          />
        ) : (
          <AreaChart
            data={windowed.map((point) => ({ x: dayToTimestamp(point.date), y: point.total }))}
            caption={`Net worth by day, ${rangeLabel(range)}`}
            valueLabel="Net worth"
            formatValue={(value) => formatAmount(value, currency)}
            formatTick={(value) => formatCompactAmount(value, currency)}
            formatX={(x) => formatDay(timestampToDay(x))}
          />
        )}
      </div>

      <EquationStrip equation={equation} asOf={latest?.date} currency={currency} />
    </section>
  );
}

/** Stands in for the chart when there is nothing worth drawing, at the chart's height. */
function ChartNotice({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-ink text-[13px]">{headline}</p>
      <p className="text-muted max-w-[46ch] text-[12px] leading-relaxed">{detail}</p>
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
  equation: NetWorthEquation;
  asOf: string | undefined;
  currency?: string;
}) {
  if (equation.terms.length === 0) return null;

  return (
    <section aria-label="Net worth equation" className="border-hairline border-t pt-4">
      {/*
       * Each operator is bound to the term it introduces, so a wrap can only
       * ever fall *between* `+ Account` units — never leaving a `+` or an `=`
       * stranded at the end of a line, which is what made four accounts read as
       * a broken list rather than a sum.
       */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-4">
        {equation.terms.map((term, index) => (
          <div key={term.accountId} className="flex shrink-0 items-start gap-x-3">
            {index > 0 ? <Operator>+</Operator> : null}
            <Term label={term.label} value={formatAmount(term.value, currency)} />
          </div>
        ))}
        <div className="flex shrink-0 items-start gap-x-3">
          <Operator>=</Operator>
          <Term label="Net worth" value={formatAmount(equation.total, currency)} emphasised />
        </div>
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

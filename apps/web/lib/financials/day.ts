/**
 * The UTC day the Financials module measures history in, the ranges measured in
 * days of it, and the arithmetic every surface built on it needs.
 *
 * One module rather than one per surface, because the day *is* the unit: net
 * worth is a sum per day (ADR 0006), flow is a total per day, and letting each
 * of them roll its own `slice(0, 10)` is exactly how the representation drifts
 * apart. The two range toggles are here for the same reason — they are spelled
 * the same, sit on the same page, and a `1M` that meant thirty days in one and a
 * calendar month in the other would be a bug nobody would think to look for.
 *
 * UTC throughout, matching the sync's own timestamps. Reinterpreting a
 * `balance-date` or a `posted` in the viewer's zone would shuffle rows across
 * the day boundary and move figures for no reason.
 */

/** The zoom levels every Financials range toggle offers. */
export type TimeRange = "1M" | "3M" | "1Y" | "ALL";

export const TIME_RANGES: readonly TimeRange[] = ["1M", "3M", "1Y", "ALL"];

/** Plain day counts rather than calendar months: predictable, and the axis is in days. */
const RANGE_DAYS: Record<Exclude<TimeRange, "ALL">, number> = {
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How a range reads in a sentence — "over 3 months", "in the last 1 month". */
export function rangeLabel(range: TimeRange): string {
  return { "1M": "1 month", "3M": "3 months", "1Y": "1 year", ALL: "all time" }[range];
}

/**
 * The first day a range admits, or `null` for `ALL` — which admits everything.
 *
 * `now` is required rather than defaulted: the callers are client components,
 * and a default `new Date()` here would read the browser's clock and disagree
 * with the server's render — a hydration mismatch waiting for midnight.
 */
export function earliestDay(range: TimeRange, now: Date): string | null {
  if (range === "ALL") return null;

  return utcDay(new Date(now.getTime() - RANGE_DAYS[range] * MS_PER_DAY).toISOString());
}

/** The `YYYY-MM-DD` day a timestamp falls on. Day strings sort lexicographically, which is the point of the format. */
export function utcDay(value: string): string | null {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
}

/** Milliseconds at the day's UTC start — what a time-spaced x-axis plots against. */
export function dayToTimestamp(day: string): number {
  return new Date(`${day}T00:00:00Z`).getTime();
}

/** The inverse, for reading a day back off an x coordinate. */
export function timestampToDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Numerics arrive from PostgREST as decimal strings; this is the boundary that parses them. */
export function toNumber(value: number | string): number | null {
  const numeric = typeof value === "number" ? value : Number.parseFloat(value);

  return Number.isFinite(numeric) ? numeric : null;
}

/** Cents, not floats: summing two-decimal money otherwise yields 100000.00000000001. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

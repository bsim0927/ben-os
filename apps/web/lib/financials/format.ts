/**
 * How money and timestamps read across the Financials module.
 *
 * Shared rather than per-page so the overview's headline and the raw-data
 * table can't disagree about what the same balance says — a difference between
 * them would look like a sync bug rather than a formatting one.
 */

/**
 * SimpleFIN's `currency` is free text and may be a URL (rewards points), which
 * Intl rejects. A thrown formatter would take the whole page down, so anything
 * that isn't ISO 4217 falls back to a plain grouped number.
 */
export function formatAmount(value: number, currency?: string): string {
  if (Number.isNaN(value)) return "—";

  if (isIsoCurrency(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
    } catch {
      // Falls through to the plain rendering below.
    }
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** For a change, where the `+` is as much of the meaning as the digits. */
export function formatSignedAmount(value: number, currency?: string): string {
  const formatted = formatAmount(Math.abs(value), currency);

  return `${value < 0 ? "−" : "+"}${formatted}`;
}

/** Axis labels, where six figures of precision would collide with the next tick. */
export function formatCompactAmount(value: number, currency?: string): string {
  if (Number.isNaN(value)) return "—";

  // `minimumFractionDigits: 0` is doing real work: compact notation otherwise
  // pins one fraction digit and every round gridline reads `$100.0K`.
  const options: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  };

  if (isIsoCurrency(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { ...options, style: "currency", currency }).format(
        value,
      );
    } catch {
      // Falls through to the plain rendering below.
    }
  }

  return new Intl.NumberFormat("en-US", options).format(value);
}

export function formatPercent(ratio: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio);
}

/**
 * UTC throughout: the sync's own timestamps are UTC, and a page that silently
 * reinterpreted them in the viewer's zone would make an off-by-hours balance
 * date look like a sync bug.
 */
export function formatTimestamp(value: string | null): string {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toISOString().replace("T", " ").slice(0, 16);
}

/** A `YYYY-MM-DD` day as `1 Aug 2026` — dense, unambiguous, no locale guessing. */
export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) return day;

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function isIsoCurrency(currency: string | undefined): currency is string {
  return currency !== undefined && /^[A-Z]{3}$/.test(currency);
}

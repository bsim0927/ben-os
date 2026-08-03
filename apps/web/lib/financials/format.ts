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
  return format(value, currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** For a change, where the `+` is as much of the meaning as the digits. */
export function formatSignedAmount(value: number, currency?: string): string {
  const formatted = formatAmount(Math.abs(value), currency);

  return `${value < 0 ? "−" : "+"}${formatted}`;
}

/** Axis labels, where six figures of precision would collide with the next tick. */
export function formatCompactAmount(value: number, currency?: string): string {
  return format(value, currency, {
    notation: "compact",
    maximumFractionDigits: 1,
    // `minimumFractionDigits: 0` is doing real work: compact notation otherwise
    // pins one fraction digit and every round gridline reads `$100.0K`.
    minimumFractionDigits: 0,
  });
}

/**
 * For a change expressed as a share, where the sign is half the meaning.
 *
 * Signed by hand rather than by `Intl`, so the minus is the same U+2212
 * `formatSignedAmount` uses. A gain reads as `−$50.00 (−5.3%)`, and mixing a
 * typographic minus with an ASCII hyphen inside one figure would show.
 */
export function formatSignedPercent(ratio: number): string {
  return `${ratio < 0 ? "−" : "+"}${formatPercent(Math.abs(ratio))}`;
}

export function formatPercent(ratio: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio);
}

/**
 * The one currency a set of figures can be labelled with, or nothing when they
 * disagree.
 *
 * Summing across currencies is wrong and v1 has one, so the honest response to
 * more than one is to drop the symbol rather than stamp a total with a currency
 * that isn't what it means. Note what this does *not* fix: the sum underneath is
 * still a sum of two currencies, and a caller that can say so should.
 *
 * Here rather than beside either caller because both the overview (across
 * Accounts) and the holdings page (across Holdings) need the same rule, and two
 * copies would be free to disagree about what an absent currency means.
 */
export function sharedCurrency(
  currencies: readonly (string | null | undefined)[],
): string | undefined {
  const named = new Set(
    currencies.filter((currency) => currency !== null && currency !== undefined),
  );

  return named.size === 1 ? [...named][0] : undefined;
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

/**
 * The one place that decides whether a currency symbol is safe to attach.
 *
 * Two layers, because either can fail: the pattern rejects the URLs SimpleFIN
 * allows, and the `catch` covers a three-letter code that is well-formed but
 * isn't a currency Intl knows.
 */
function format(value: number, currency: string | undefined, options: Intl.NumberFormatOptions) {
  if (Number.isNaN(value)) return "—";

  if (currency !== undefined && /^[A-Z]{3}$/.test(currency)) {
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

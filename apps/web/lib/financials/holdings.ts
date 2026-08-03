/**
 * What an investment Account is actually made of: the current Holdings, the
 * figures derived from them, and the sections they are read in.
 *
 * Two jobs, and the first is the one that is easy to get wrong.
 *
 * **Selection.** `financials_holding` is append-on-sync (ADR 0004 decision 1):
 * every sync writes a fresh row per Security rather than updating one, so the
 * table holds every reading ever taken and "current holdings" is a query, not a
 * table. It resolves to the rows stamped with the account's *latest* `as_of` —
 * per account, because the two Fidelity accounts sync seconds apart and a single
 * global maximum would empty whichever one finished first. Taking the latest row
 * per `(account, security)` instead would look equivalent, and is not: a
 * holding sold between two syncs would keep its last reading forever, sitting
 * in the ledger as a holding that no longer exists.
 *
 * **Derivation.** Nothing below is stored. `market_value` and `total_cost_basis`
 * are `quantity ×` a per-unit column by ADR 0004 decision 3, precisely so there
 * is no second figure to drift; the gain, the shares and the subtotals are the
 * same arithmetic one level up. The one thing that is *not* derived is which
 * section a holding lands in — that is `financials_security.security_type`,
 * which conflates a security's wrapper with its asset class (a bond ETF is an
 * ETF here, not fixed income). The page says so rather than pretending
 * otherwise; see ADR 0009.
 */

import { round, toNumber } from "@/lib/financials/day";
import { sharedCurrency } from "@/lib/financials/format";

/** A `financials_holding` row joined to its security, as PostgREST returns it. */
export type HoldingSnapshotInput = {
  accountId: string;
  securityId: string;
  symbol: string;
  securityName: string | null;
  securityType: string;
  /** Numerics arrive as decimal strings. `quantity` is `not null`; the rest are not. */
  quantity: number | string;
  averageCostBasis: number | string | null;
  marketPrice: number | string | null;
  currency: string | null;
  /** Raw jsonb — the provider's shape, not this app's. See `readTaxLots`. */
  taxLots: unknown;
  asOf: string;
};

/**
 * One lot of a holding, as much of it as the payload could be read for.
 *
 * Every field is nullable because this shape has never been seen in this
 * database: SnapTrade gates lot detail behind its paid plans, so on Personal the
 * column is null for every row it has ever written. What is modelled here is
 * therefore what a lot *is* — some units, bought at some price, on some day —
 * rather than a schema anyone has confirmed.
 */
export type TaxLot = {
  quantity: number | null;
  /** What the lot was bought at, per unit. */
  costPerUnit: number | null;
  /** The acquisition date as the provider worded it, not reformatted. */
  acquiredOn: string | null;
};

export type Holding = {
  securityId: string;
  symbol: string;
  name: string | null;
  securityType: string;
  quantity: number;
  /** Per unit, as stored. */
  averageCostBasis: number | null;
  /** Per unit, as stored. */
  marketPrice: number | null;
  /** `quantity × marketPrice`, or null where the provider sent no price. */
  marketValue: number | null;
  /** `quantity × averageCostBasis`, or null where the holding arrived without one. */
  costBasis: number | null;
  /** Unrealized: `marketValue − costBasis`, and null unless both are known. */
  gain: number | null;
  /** The same gain against what was paid. Null on a zero basis — see `ratio`. */
  gainRatio: number | null;
  /** This holding's share of the account's total value. */
  shareOfAccount: number | null;
  currency: string | null;
  /** Null where the provider sent no lot detail, which is not the same as none. */
  taxLots: TaxLot[] | null;
};

export type HoldingsGroup = {
  /** `financials_security.security_type`, verbatim. */
  securityType: string;
  label: string;
  holdings: Holding[];
  count: number;
  value: number;
  costBasis: number;
  gain: number;
  gainRatio: number | null;
  shareOfAccount: number | null;
};

export type HoldingsView = {
  /** The reading every figure here came from, or null before the first sync. */
  asOf: string | null;
  /** Undefined where the holdings disagree — see `sharedCurrency`. */
  currency?: string;
  /** The totals summed across more than one currency, which no symbol can fix. */
  mixedCurrency: boolean;
  totalValue: number;
  totalCostBasis: number;
  gain: number;
  gainRatio: number | null;
  groups: HoldingsGroup[];
  /** Current holdings in total. */
  holdings: number;
  /**
   * How many of them the totals could actually be built from. Below
   * `holdings`, the strip is summing a subset and says so — a total quietly
   * short of a holding is the one figure nobody would question.
   */
  pricedHoldings: number;
  costedHoldings: number;
  /**
   * How many arrived with a lot breakdown. Zero is the normal reading on
   * SnapTrade's Personal plan, and the page says which of "none were sent" and
   * "only some were" it is looking at rather than leaving a gap to interpret.
   */
  reportsTaxLots: number;
};

export type BuildHoldingsViewInput = {
  accountId: string;
  holdings: readonly HoldingSnapshotInput[];
};

/**
 * ADR 0004's `security_type` vocabulary, in words.
 *
 * A type with no entry keeps its raw value as its label rather than being folded
 * into "Other": the vocabulary is a check constraint away from growing, and a
 * section headed `warrant` is a worse page than one headed "Warrants" but a far
 * better one than holdings silently pooled under a heading that isn't theirs.
 */
const TYPE_LABELS: Record<string, string> = {
  equity: "Equities",
  etf: "ETFs",
  mutual_fund: "Mutual funds",
  fixed_income: "Fixed income",
  cash: "Cash & equivalents",
  crypto: "Crypto",
  option: "Options",
  other: "Other",
};

export function labelForSecurityType(securityType: string): string {
  return TYPE_LABELS[securityType] ?? securityType;
}

export function buildHoldingsView({ accountId, holdings }: BuildHoldingsViewInput): HoldingsView {
  const reading = latestReading(accountId, holdings);
  const asOf = reading[0]?.asOf ?? null;

  // Two passes, because a holding's share of the account cannot be known until
  // the account's total is. The alternative — a share filled in afterwards by
  // mutation — is the kind of half-built object that ends up rendered.
  const priced = reading.map((row) => ({
    row,
    quantity: toNumber(row.quantity) ?? 0,
    averageCostBasis: optionalNumber(row.averageCostBasis),
    marketPrice: optionalNumber(row.marketPrice),
  }));

  const values = priced.map(({ quantity, marketPrice }) =>
    marketPrice === null ? null : round(quantity * marketPrice),
  );
  const bases = priced.map(({ quantity, averageCostBasis }) =>
    averageCostBasis === null ? null : round(quantity * averageCostBasis),
  );

  const totalValue = sum(values);
  const totalCostBasis = sum(bases);

  const current: Holding[] = priced.map((entry, index) => {
    const marketValue = values[index];
    const costBasis = bases[index];
    const holdingGain =
      marketValue === null || costBasis === null ? null : round(marketValue - costBasis);

    return {
      securityId: entry.row.securityId,
      symbol: entry.row.symbol,
      name: entry.row.securityName,
      securityType: entry.row.securityType,
      quantity: entry.quantity,
      averageCostBasis: entry.averageCostBasis,
      marketPrice: entry.marketPrice,
      marketValue,
      costBasis,
      gain: holdingGain,
      // `holdingGain` is only non-null when `costBasis` is, but the two are
      // checked together so the compiler can see it as well as a reader can.
      gainRatio: holdingGain === null || costBasis === null ? null : ratio(holdingGain, costBasis),
      // Against the account's total value rather than its balance: the balance
      // is SimpleFIN's figure for a different provider's account, and a column
      // of shares that summed to 97% would read as an arithmetic bug.
      shareOfAccount: marketValue === null ? null : ratio(marketValue, totalValue),
      currency: entry.row.currency,
      taxLots: readTaxLots(entry.row.taxLots),
    };
  });

  const currencies = new Set(reading.map((row) => row.currency).filter((code) => code !== null));

  return {
    asOf,
    // Undefined where the holdings disagree, for the reason the overview drops
    // it across accounts: a total stamped with one of several currencies claims
    // to be something it isn't.
    currency: sharedCurrency(reading.map((row) => row.currency)),
    // Said out loud rather than merely unlabelled, because dropping the symbol
    // makes the figure honest about its units and not about its arithmetic —
    // the sum underneath still added two currencies together.
    mixedCurrency: currencies.size > 1,
    totalValue,
    totalCostBasis,
    ...gainOver(current),
    groups: groupHoldings(current, totalValue),
    holdings: current.length,
    pricedHoldings: current.filter((holding) => holding.marketValue !== null).length,
    costedHoldings: current.filter((holding) => holding.costBasis !== null).length,
    reportsTaxLots: current.filter((holding) => holding.taxLots !== null).length,
  };
}

/**
 * The unrealized gain over a set of holdings, summed from the ones that have
 * both figures — **not** taken as their total value minus their total cost.
 *
 * The two agree whenever every holding is priced and costed, which is every
 * reading this database has taken. They part company on a holding that arrived
 * without a basis — a transfer in, routinely — where the difference of the
 * totals would report that holding's entire value as profit.
 *
 * Shared by the account's summary and each section's subtotal because it is one
 * rule, not two that happen to agree: a section holding a single uncosted
 * position needs the same treatment the whole account does.
 */
function gainOver(holdings: readonly Holding[]): { gain: number; gainRatio: number | null } {
  const comparable = holdings.filter((holding) => holding.gain !== null);
  const gain = sum(comparable.map((holding) => holding.gain));

  // Against what the *comparable* holdings cost, which is not always the cost
  // basis shown beside it — see `costedHoldings`, and the line the page prints
  // when the two are measured over different sets.
  return { gain, gainRatio: ratio(gain, sum(comparable.map((holding) => holding.costBasis))) };
}

/**
 * The rows of this account's most recent reading.
 *
 * Scoped to one account and then to one `as_of` — see the module comment for why
 * both halves matter. `(account_id, security_id, as_of)` is unique, so one row
 * per security falls out of the key rather than needing to be enforced here.
 */
function latestReading(
  accountId: string,
  holdings: readonly HoldingSnapshotInput[],
): HoldingSnapshotInput[] {
  const mine = holdings.filter((row) => row.accountId === accountId);

  if (mine.length === 0) return [];

  // ISO-8601 timestamps from the same source and offset, so the lexical maximum
  // is the chronological one — but they are compared as instants anyway, since
  // `+00:00` and `Z` are the same moment written two ways and PostgREST has sent
  // both.
  const latest = mine.reduce((newest, row) =>
    instant(row.asOf) > instant(newest.asOf) ? row : newest,
  ).asOf;

  return mine.filter((row) => instant(row.asOf) === instant(latest));
}

function instant(value: string): number {
  const parsed = new Date(value).getTime();

  // An unparseable timestamp sorts oldest rather than newest: a row whose
  // reading time cannot be read should never be the one that defines "current".
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * The sections, heaviest first.
 *
 * By value rather than by a fixed vocabulary order, so the section a reader
 * came for is at the top and the donut's slices run in the same order as the
 * ledger below it. Ties break on the label so a re-render cannot reshuffle two
 * sections that happen to be worth the same.
 */
function groupHoldings(holdings: readonly Holding[], totalValue: number): HoldingsGroup[] {
  const byType = new Map<string, Holding[]>();

  for (const holding of holdings) {
    const rows = byType.get(holding.securityType) ?? [];

    rows.push(holding);
    byType.set(holding.securityType, rows);
  }

  return [...byType.entries()]
    .map(([securityType, rows]) => {
      const value = sum(rows.map((holding) => holding.marketValue));
      const costBasis = sum(rows.map((holding) => holding.costBasis));

      return {
        securityType,
        label: labelForSecurityType(securityType),
        // Largest first, matching the summary's framing — the sort controls
        // reorder from here rather than from an arbitrary starting point.
        holdings: sortHoldings(rows, DEFAULT_SORT.column, DEFAULT_SORT.direction),
        count: rows.length,
        value,
        costBasis,
        ...gainOver(rows),
        shareOfAccount: ratio(value, totalValue),
      };
    })
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** The columns a section's table can be ordered by. */
export type HoldingColumn =
  | "holding"
  | "quantity"
  | "averageCostBasis"
  | "marketPrice"
  | "marketValue"
  | "gain"
  | "gainRatio"
  | "shareOfAccount";

export type SortDirection = "asc" | "desc";

/**
 * How a section opens, before anyone clicks a header.
 *
 * Stated once and used twice — the built groups arrive in this order, and the
 * ledger starts its sort state here. Two declarations of one fact would let a
 * section render in an order its own header arrow denied.
 */
export const DEFAULT_SORT: { column: HoldingColumn; direction: SortDirection } = {
  column: "marketValue",
  direction: "desc",
};

/**
 * One section's holdings, reordered.
 *
 * Takes and returns a section's rows rather than the whole account's, because
 * the sort is deliberately scoped to a section: a global sort would scramble the
 * grouping that is the point of the layout (spec #37). Returns a new array — the
 * caller holds the built view, and a sort that reordered it in place would make
 * a later render disagree with the one before it.
 */
export function sortHoldings(
  holdings: readonly Holding[],
  column: HoldingColumn,
  direction: SortDirection,
): Holding[] {
  const sign = direction === "asc" ? 1 : -1;

  return [...holdings].sort((a, b) => {
    if (column === "holding") {
      return sign * a.symbol.localeCompare(b.symbol);
    }

    const left = a[column];
    const right = b[column];

    // A figure the provider never sent is not a small one. It sorts last in
    // both directions, so an unpriced holding never leads an ascending value
    // column as though it were the cheapest thing in the account.
    if (left === null || right === null) {
      return left === right ? 0 : left === null ? 1 : -1;
    }

    return sign * (left - right) || a.symbol.localeCompare(b.symbol);
  });
}

/**
 * The lots behind a holding, or null where there are none to show.
 *
 * Read defensively on purpose. The column is jsonb holding whatever the provider
 * sent, this app has never seen a populated one (SnapTrade's Personal plan sends
 * none), and the field names below are therefore the plausible spellings rather
 * than a contract. A payload that doesn't fit costs the holding its lot detail
 * and nothing else — the raw jsonb is still in the row, and a page that threw on
 * an unexpected shape would be a worse answer than a holding shown without its
 * breakdown.
 */
function readTaxLots(value: unknown): TaxLot[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const lots = value
    .filter((lot): lot is Record<string, unknown> => typeof lot === "object" && lot !== null)
    .map((lot) => ({
      // Two spellings each, not every spelling imaginable: the first is what
      // `SnapTradePosition` already calls the same quantity on the wire, and the
      // second is the obvious alternative. Guessing more widely would be
      // inventing a contract rather than tolerating one.
      quantity: firstNumber(lot, ["units", "quantity"]),
      costPerUnit: firstNumber(lot, ["price", "cost_basis"]),
      acquiredOn: firstString(lot, ["acquired_date", "purchase_date"]),
    }));

  return lots.length === 0 ? null : lots;
}

function firstNumber(lot: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = lot[key];

    if (typeof value === "number" || typeof value === "string") {
      const numeric = toNumber(value);

      if (numeric !== null) return numeric;
    }
  }

  return null;
}

function firstString(lot: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = lot[key];

    if (typeof value === "string" && value.trim() !== "") return value;
  }

  return null;
}

/** Nulls are absences, not zeroes — they leave the sum alone, and are counted separately. */
function sum(values: readonly (number | null)[]): number {
  return round(values.reduce((total: number, value) => total + (value ?? 0), 0));
}

function optionalNumber(value: number | string | null): number | null {
  return value === null ? null : toNumber(value);
}

/** A share, or null where the denominator is nothing to be a share of. */
function ratio(value: number, of: number): number | null {
  return of === 0 ? null : value / of;
}

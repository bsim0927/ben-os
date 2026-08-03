"use client";

import { useState } from "react";

import { MicroLabel } from "@/components/console";
import { donutGeometry } from "@/lib/chart";
import {
  formatAmount,
  formatPercent,
  formatSignedAmount,
  formatSignedPercent,
} from "@/lib/financials/format";
import {
  sortPositions,
  type HoldingsGroup,
  type HoldingsView,
  type Position,
  type PositionColumn,
  type SortDirection,
  type TaxLot,
} from "@/lib/financials/holdings";

/**
 * The grouped ledger: what an investment Account is made of, sectioned by
 * security type.
 *
 * A client component for two interactions and no writes. Sorting is scoped to a
 * section rather than to the table (spec #37) — the grouping is the layout's
 * whole point, and a global sort would scramble it — and the lot breakdown
 * expands in place. Nothing here is saved: unlike a Chase transaction there is
 * no user-owned field on a Holding, so this page reads and never writes.
 *
 * Every figure arrives already derived (`buildHoldingsView`), so this file
 * contains no arithmetic beyond choosing how a number reads.
 */

const DONUT_SIZE = 132;
const DONUT_THICKNESS = 22;

/**
 * One accent at descending weight, rather than a categorical palette.
 *
 * The Console identity is one restrained accent colour, and eight competing hues
 * would be a different design. It costs the donut some slice-to-slice
 * distinction, which the legend pays back: every slice's share is written beside
 * its swatch, so the chart is the shape and the legend is the reading. Longer
 * than any account's list of security types, so a slice never falls off the end.
 */
const SLICE_OPACITY = [1, 0.72, 0.54, 0.4, 0.3, 0.22, 0.16, 0.12];

function sliceOpacity(index: number): number {
  return SLICE_OPACITY[index] ?? SLICE_OPACITY[SLICE_OPACITY.length - 1];
}

export type HoldingsLedgerProps = {
  view: HoldingsView;
  accountName: string;
};

/** How each section is currently ordered, keyed by security type. */
type SortState = Record<string, { column: PositionColumn; direction: SortDirection }>;

export function HoldingsLedger({ view, accountName }: HoldingsLedgerProps) {
  const [sorts, setSorts] = useState<SortState>({});

  if (view.groups.length === 0) {
    return (
      <p className="border-hairline text-muted border-t pt-3 text-[13px]">
        No holdings synced for {accountName} yet. Holdings arrive from SnapTrade once the account is
        linked through the Connection Portal, and the schedule pulls them daily from there.
      </p>
    );
  }

  /**
   * Clicking the column a section is already sorted by reverses it; clicking a
   * different one starts that column at the end a reader wants first — largest
   * for a figure, A–Z for a name.
   */
  const toggle = (securityType: string, column: PositionColumn) =>
    setSorts((current) => {
      const active = current[securityType] ?? defaultSort;

      return {
        ...current,
        [securityType]:
          active.column === column
            ? { column, direction: active.direction === "asc" ? "desc" : "asc" }
            : { column, direction: column === "position" ? "asc" : "desc" },
      };
    });

  return (
    <div className="flex flex-col gap-8">
      <Allocation view={view} />

      <section aria-label="Positions" className="flex flex-col gap-4">
        {view.groups.map((group) => (
          <GroupSection
            key={group.securityType}
            group={group}
            currency={view.currency}
            sort={sorts[group.securityType] ?? defaultSort}
            onSort={(column) => toggle(group.securityType, column)}
          />
        ))}

        {/*
         * Said once, under the ledger, rather than as an empty column in every
         * row. SnapTrade gates lot detail behind its paid plans, so on Personal
         * this is the normal reading rather than a fault — and a page that
         * silently showed no lots would look like one that had lost them.
         */}
        {view.groups.every((group) => group.positions.every((p) => p.taxLots === null)) ? (
          <p className="text-muted text-[12px]">
            No per-lot cost basis in this reading — SnapTrade&apos;s Personal plan reports a
            position&apos;s average cost only. Lots appear here for any position that arrives with
            them.
          </p>
        ) : null}
      </section>
    </div>
  );
}

const defaultSort = { column: "marketValue", direction: "desc" } as const;

/**
 * The composition strip: a donut and the legend that reads it.
 *
 * Compact on purpose — it is context for the ledger below, not the page's
 * subject. The caption is not decoration either: `security_type` is the wrapper
 * a security comes in, and a reader who took it for an asset-class split would
 * conclude a bond ETF was equity exposure.
 */
function Allocation({ view }: { view: HoldingsView }) {
  const { slices, center, radius } = donutGeometry({
    values: view.groups.map((group) => group.value),
    size: DONUT_SIZE,
    thickness: DONUT_THICKNESS,
  });

  return (
    <section
      aria-label="Allocation"
      className="border-hairline bg-panel flex flex-col gap-5 rounded-md border px-4 py-4 sm:flex-row sm:items-center"
    >
      {slices.length > 0 ? (
        <svg
          viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
          width={DONUT_SIZE}
          height={DONUT_SIZE}
          className="shrink-0"
          aria-hidden="true"
        >
          {slices.map((slice) => (
            <path
              key={slice.index}
              d={slice.path}
              className="fill-accent"
              opacity={sliceOpacity(slice.index)}
            />
          ))}
          <text
            x={center.x}
            y={center.y - 2}
            textAnchor="middle"
            fontSize={11}
            className="fill-muted"
          >
            {view.groups.length} {view.groups.length === 1 ? "type" : "types"}
          </text>
          <text
            x={center.x}
            y={center.y + 12}
            textAnchor="middle"
            fontSize={11}
            className="fill-muted tabular-nums"
          >
            {view.positions} {view.positions === 1 ? "position" : "positions"}
          </text>
          <circle cx={center.x} cy={center.y} r={radius} fill="none" />
        </svg>
      ) : null}

      <div className="min-w-0 flex-1">
        {/*
         * A list rather than a table: the legend's job is to name the slices and
         * their shares, and the same figures are subtotalled properly in each
         * section header below.
         */}
        <ul className="flex flex-col gap-1.5">
          {view.groups.map((group, index) => (
            <li key={group.securityType} className="flex items-center gap-2.5 text-[13px]">
              <span
                aria-hidden="true"
                className="bg-accent size-2.5 shrink-0 rounded-[2px]"
                style={{ opacity: sliceOpacity(index) }}
              />
              <span className="text-ink min-w-0 flex-1 truncate">{group.label}</span>
              <span className="text-muted tabular-nums">
                {group.shareOfAccount === null ? "—" : formatPercent(group.shareOfAccount)}
              </span>
              <span className="text-ink w-28 text-right tabular-nums">
                {formatAmount(group.value, view.currency)}
              </span>
            </li>
          ))}
        </ul>

        <p className="text-muted mt-3 text-[12px]">
          Grouped by the security&apos;s type, which is its wrapper rather than its asset class — a
          bond ETF counts as an ETF here, not as fixed income. This is a composition view, not a
          stock/bond split.
        </p>
      </div>
    </section>
  );
}

type SortableColumn = {
  column: PositionColumn;
  label: string;
  /** Names sort left, figures sort right — the column reads under its own digits. */
  numeric: boolean;
};

const COLUMNS: readonly SortableColumn[] = [
  { column: "position", label: "Position", numeric: false },
  { column: "quantity", label: "Quantity", numeric: true },
  { column: "averageCostBasis", label: "Avg cost", numeric: true },
  { column: "marketPrice", label: "Market price", numeric: true },
  { column: "marketValue", label: "Market value", numeric: true },
  { column: "gain", label: "Gain/loss", numeric: true },
  { column: "gainRatio", label: "Gain/loss %", numeric: true },
  { column: "shareOfAccount", label: "% of account", numeric: true },
];

function GroupSection({
  group,
  currency,
  sort,
  onSort,
}: {
  group: HoldingsGroup;
  currency?: string;
  sort: { column: PositionColumn; direction: SortDirection };
  onSort: (column: PositionColumn) => void;
}) {
  const positions = sortPositions(group.positions, sort.column, sort.direction);

  return (
    <section
      aria-label={`Holdings — ${group.label}`}
      className="border-hairline bg-panel rounded-md border"
    >
      <header className="border-hairline flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-3">
        <div className="flex items-baseline gap-3">
          <MicroLabel as="h3">{group.label}</MicroLabel>
          <span className="text-muted text-[12px] tabular-nums">
            {group.count} {group.count === 1 ? "position" : "positions"}
          </span>
        </div>

        <div className="flex items-baseline gap-5 text-[13px] tabular-nums">
          <GainLoss gain={group.gain} ratio={group.gainRatio} currency={currency} />
          <span className="text-ink">{formatAmount(group.value, currency)}</span>
        </div>
      </header>

      {/* Eight columns of figures is wide; narrowing is the table's problem. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-[13px]">
          <caption className="sr-only">
            {group.label} — {group.count} positions, sorted by{" "}
            {COLUMNS.find((entry) => entry.column === sort.column)?.label},{" "}
            {sort.direction === "asc" ? "ascending" : "descending"}
          </caption>
          <thead>
            <tr className="border-hairline border-b">
              {COLUMNS.map((entry) => (
                <th
                  key={entry.column}
                  scope="col"
                  aria-sort={
                    sort.column === entry.column
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className={`px-2 py-2 ${entry.numeric ? "text-right" : "text-left"} first:pl-4 last:pr-4`}
                >
                  <button
                    type="button"
                    onClick={() => onSort(entry.column)}
                    className={`text-muted hover:text-ink text-[11px] tracking-[0.08em] uppercase ${
                      sort.column === entry.column ? "text-accent" : ""
                    }`}
                  >
                    {entry.label}
                    <span aria-hidden="true" className="ml-1">
                      {sort.column === entry.column ? (sort.direction === "asc" ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <PositionRow key={position.securityId} position={position} currency={currency} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PositionRow({ position, currency }: { position: Position; currency?: string }) {
  const [showLots, setShowLots] = useState(false);
  const lots = position.taxLots;

  return (
    <>
      <tr className="border-hairline text-ink border-b last:border-b-0">
        <td className="px-2 py-2 pl-4">
          <span className="text-ink font-medium">{position.symbol}</span>
          {position.name ? (
            <span className="text-muted ml-2 text-[12px]">{position.name}</span>
          ) : null}
          {lots ? (
            <button
              type="button"
              onClick={() => setShowLots((open) => !open)}
              aria-expanded={showLots}
              className="text-muted hover:text-ink border-hairline ml-2 rounded border px-1.5 py-px text-[11px]"
            >
              {lots.length} {lots.length === 1 ? "lot" : "lots"}
            </button>
          ) : null}
        </td>
        <td className="px-2 py-2 text-right">
          <Quantity value={position.quantity} />
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          <Optional value={position.averageCostBasis} currency={position.currency ?? currency} />
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          <Optional value={position.marketPrice} currency={position.currency ?? currency} />
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          <Optional value={position.marketValue} currency={position.currency ?? currency} />
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          {position.gain === null ? (
            <span className="text-muted">—</span>
          ) : (
            <span className={toneFor(position.gain)}>
              {signedAmount(position.gain, position.currency ?? currency)}
            </span>
          )}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          {position.gainRatio === null ? (
            <span className="text-muted">—</span>
          ) : (
            <span className={toneFor(position.gainRatio)}>{signedPercent(position.gainRatio)}</span>
          )}
        </td>
        <td className="text-muted px-2 py-2 pr-4 text-right tabular-nums">
          {position.shareOfAccount === null ? "—" : formatPercent(position.shareOfAccount)}
        </td>
      </tr>

      {showLots && lots ? (
        <tr className="border-hairline bg-panel-2 border-b last:border-b-0">
          <td colSpan={COLUMNS.length} className="px-4 py-3">
            <Lots lots={lots} symbol={position.symbol} currency={position.currency ?? currency} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The lot breakdown, as much of it as the provider sent.
 *
 * Each field is rendered as absent rather than as zero when it is missing: the
 * shape of this payload is the brokerage's, and a lot that names units but no
 * purchase price is a lot we know something about, not a free one.
 */
function Lots({
  lots,
  symbol,
  currency,
}: {
  lots: readonly TaxLot[];
  symbol: string;
  currency?: string;
}) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <caption className="text-muted mb-2 text-left text-[11px] tracking-[0.08em] uppercase">
        {symbol} — tax lots
      </caption>
      <thead>
        <tr className="border-hairline border-b">
          <th scope="col" className="text-muted py-1 text-left font-normal">
            Acquired
          </th>
          <th scope="col" className="text-muted py-1 text-right font-normal">
            Quantity
          </th>
          <th scope="col" className="text-muted py-1 text-right font-normal">
            Cost per unit
          </th>
          <th scope="col" className="text-muted py-1 text-right font-normal">
            Lot cost
          </th>
        </tr>
      </thead>
      <tbody>
        {lots.map((lot, index) => (
          <tr key={index} className="border-hairline border-b last:border-b-0">
            <td className="py-1">{lot.acquiredOn ?? "—"}</td>
            <td className="py-1 text-right">
              {lot.quantity === null ? "—" : <Quantity value={lot.quantity} />}
            </td>
            <td className="py-1 text-right tabular-nums">
              <Optional value={lot.costPerUnit} currency={currency} />
            </td>
            <td className="py-1 text-right tabular-nums">
              <Optional
                value={
                  lot.quantity === null || lot.costPerUnit === null
                    ? null
                    : lot.quantity * lot.costPerUnit
                }
                currency={currency}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A section's or the account's gain, as a figure and a share, side by side. */
export function GainLoss({
  gain,
  ratio,
  currency,
}: {
  gain: number;
  ratio: number | null;
  currency?: string;
}) {
  return (
    <span className={`${toneFor(gain)} tabular-nums`}>
      {signedAmount(gain, currency)}
      {ratio === null ? "" : ` (${signedPercent(ratio)})`}
    </span>
  );
}

/**
 * A gain carries its sign; a gain of nothing does not.
 *
 * The same rule the balance bridge applies to its segments: `+$0.00` claims a
 * direction that a change of nothing does not have, and a money-market position
 * held at par is exactly that case on every reading.
 */
function signedAmount(value: number, currency?: string): string {
  return value === 0 ? formatAmount(value, currency) : formatSignedAmount(value, currency);
}

function signedPercent(ratio: number): string {
  return ratio === 0 ? formatPercent(ratio) : formatSignedPercent(ratio);
}

/**
 * Share counts, not money: no currency symbol and no forced two decimals, since
 * a fractional position is routinely 0.00123456 and rounding it to cents would
 * print it as zero.
 */
function Quantity({ value }: { value: number }) {
  return (
    <span className="tabular-nums">
      {value.toLocaleString("en-US", { maximumFractionDigits: 8 })}
    </span>
  );
}

/** A figure the provider never sent is an em dash, not a zero. */
function Optional({ value, currency }: { value: number | null; currency?: string }) {
  if (value === null) return <span className="text-muted">—</span>;

  return <>{formatAmount(value, currency)}</>;
}

/** Zero is neither a gain nor a loss, and colouring it as one would be a claim. */
function toneFor(value: number): string {
  return value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted";
}

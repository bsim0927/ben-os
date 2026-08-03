"use client";

import { useMemo, useState } from "react";

import { MicroLabel, SegmentedToggle } from "@/components/console";
import { Sparkline } from "@/components/sparkline";
import { assignCategory, createCategory } from "@/lib/financials/categorize";
import { messageFor } from "@/lib/errors";
import { formatAmount, formatDay, formatSignedAmount } from "@/lib/financials/format";
import { dayToTimestamp, rangeLabel, TIME_RANGES, type TimeRange } from "@/lib/financials/day";
import {
  buildFlowPanels,
  UNCATEGORIZED_LABEL,
  type CategoryRef,
  type FlowAccountRef,
  type FlowPanel,
  type FlowTransaction,
  type FlowTransactionInput,
} from "@/lib/financials/flow";

/**
 * The flow panels: one per depository Account, saying what came in, what went
 * out, where it went, and letting a transaction be put in a category.
 *
 * A client component because categorizing is the module's only write, and it has
 * to feel like a click rather than a page load. Every transaction the period
 * could need is already here, so the period toggle and the picker both resolve
 * locally; the only round trip is the one that saves.
 *
 * `today` is passed in rather than read from the clock, for the reason the net
 * worth hero takes it: the server and the client have to agree on where the
 * period starts, and `new Date()` here would disagree at midnight.
 */

/** Enough rows to scan without scrolling past the panel; the rest are one click away. */
const VISIBLE_TRANSACTIONS = 12;

export type FlowPanelsProps = {
  /** Depository accounts only — a brokerage gets the balance bridge, not this. */
  accounts: readonly FlowAccountRef[];
  transactions: readonly FlowTransactionInput[];
  categories: readonly CategoryRef[];
  /** ISO timestamp the periods are measured back from. */
  today: string;
  /** The page hit its row bound, so the widest periods may not be whole. */
  truncated?: boolean;
};

export function FlowPanels({
  accounts,
  transactions,
  categories: seeded,
  today,
  truncated = false,
}: FlowPanelsProps) {
  const [period, setPeriod] = useState<TimeRange>("1M");
  // Both of these start from the server's rows and then run ahead of them: a
  // category named here, or a transaction moved into one, has to show
  // immediately rather than after a refresh that nothing has asked for.
  const [categories, setCategories] = useState<readonly CategoryRef[]>(seeded);
  const [assigned, setAssigned] = useState<Record<string, string | null>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      transactions.map((row) =>
        row.id in assigned ? { ...row, categoryId: assigned[row.id] } : row,
      ),
    [transactions, assigned],
  );

  const panels = useMemo(
    () =>
      buildFlowPanels({ accounts, transactions: rows, categories, period, now: new Date(today) }),
    [accounts, rows, categories, period, today],
  );

  // No panels, no section. An active depository account always gets one — an
  // empty period is a state the panel itself has words for — so this is only
  // ever "there is nothing here that flow is the right framing for", and a box
  // saying that below the net worth chart would be noise, not information.
  if (panels.length === 0) return null;

  /**
   * Moves a transaction into a category on screen first, and puts it back if the
   * write is refused.
   *
   * Optimistic because the alternative is a row that does nothing for a round
   * trip while the next one is already being clicked; reverting on failure is
   * what keeps that from quietly becoming a lie.
   */
  async function pick(transaction: FlowTransaction, categoryId: string | null) {
    const previous = transaction.categoryId;

    setOpenPicker(null);
    setFailure(null);
    setAssigned((current) => ({ ...current, [transaction.id]: categoryId }));

    try {
      await assignCategory(transaction.id, categoryId);
    } catch (cause) {
      setAssigned((current) => ({ ...current, [transaction.id]: previous }));
      setFailure(messageFor(cause));
    }
  }

  /** Names a category and puts this transaction in it — the only way a first one exists. */
  async function create(transaction: FlowTransaction, name: string) {
    setFailure(null);

    let category: CategoryRef;

    try {
      category = await createCategory(name);
    } catch (cause) {
      setOpenPicker(null);
      setFailure(messageFor(cause));

      return;
    }

    setCategories((current) =>
      current.some((existing) => existing.id === category.id)
        ? current
        : [...current, category].sort((a, b) => a.name.localeCompare(b.name)),
    );

    await pick(transaction, category.id);
  }

  return (
    <section aria-label="Cash flow" className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <MicroLabel as="h2">Cash flow</MicroLabel>
          <p className="text-muted mt-1 text-[13px]">
            Money in and out of each depository account, and where it went.
          </p>
          {/*
           * Said out loud rather than left to be inferred from a total that
           * looks plausible: the row bound is across every account at once, so
           * it bites a busy period long before any single panel looks short.
           */}
          {truncated ? (
            <p className="text-muted mt-1 text-[12px]">
              Only the {transactions.length.toLocaleString("en-US")} most recent transactions are
              loaded — the longer periods may be incomplete.
            </p>
          ) : null}
        </div>

        <SegmentedToggle
          label="Flow period"
          options={TIME_RANGES}
          selected={period}
          onChange={setPeriod}
        />
      </header>

      {failure ? (
        <p role="alert" className="border-hairline text-negative border-t pt-3 text-[13px]">
          Could not save that category: {failure}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        {panels.map((panel) => (
          <AccountPanel
            key={panel.account.id}
            panel={panel}
            categories={categories}
            period={period}
            openPicker={openPicker}
            onOpenPicker={setOpenPicker}
            onPick={pick}
            onCreate={create}
          />
        ))}
      </div>
    </section>
  );
}

function AccountPanel({
  panel,
  categories,
  period,
  openPicker,
  onOpenPicker,
  onPick,
  onCreate,
}: {
  panel: FlowPanel;
  categories: readonly CategoryRef[];
  period: TimeRange;
  openPicker: string | null;
  onOpenPicker: (transactionId: string | null) => void;
  onPick: (transaction: FlowTransaction, categoryId: string | null) => void;
  onCreate: (transaction: FlowTransaction, name: string) => void;
}) {
  const { account, stats, bars, trend, transactions } = panel;
  const currency = account.currency;

  return (
    <section
      aria-label={`Cash flow — ${account.name}`}
      className="border-hairline bg-panel rounded-md border"
    >
      <header className="border-hairline flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <MicroLabel as="h3">{account.name}</MicroLabel>
        {/*
         * The line ends on the net figure below it, because it is the running
         * total of the same transactions — context for the stat, not a second
         * measurement of it.
         */}
        <Sparkline
          data={trend.map((point) => ({ x: dayToTimestamp(point.date), y: point.total }))}
          label={`Net flow over ${rangeLabel(period)}, ending at ${formatSignedAmount(stats.net, currency)}`}
        />
      </header>

      {transactions.length === 0 ? (
        // Not three zeroes: nothing came in and nothing went out are claims
        // about money, and an empty period is a claim about the period.
        <p className="text-muted px-4 py-10 text-center text-[13px]">
          {period === "ALL"
            ? "No transactions on record for this account."
            : `No transactions in the last ${rangeLabel(period)}.`}
        </p>
      ) : (
        <>
          <dl className="border-hairline grid grid-cols-1 border-b sm:grid-cols-3">
            <Stat label="Income" value={formatAmount(stats.income, currency)} tone="positive" />
            <Stat label="Expenses" value={formatAmount(stats.expenses, currency)} />
            <Stat
              label="Net"
              value={formatSignedAmount(stats.net, currency)}
              tone={stats.net < 0 ? "negative" : "positive"}
            />
          </dl>

          <CategoryBars bars={bars} currency={currency} accountName={account.name} />

          <TransactionList
            transactions={transactions}
            categories={categories}
            currency={currency}
            accountName={account.name}
            openPicker={openPicker}
            onOpenPicker={onOpenPicker}
            onPick={onPick}
            onCreate={onCreate}
          />
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const color =
    tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-ink";

  return (
    <div className="border-hairline px-4 py-3 not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l">
      <dt className="text-muted text-[11px] tracking-[0.08em] uppercase">{label}</dt>
      <dd className={`mt-1 text-[20px] leading-none tabular-nums ${color}`}>{value}</dd>
    </div>
  );
}

/**
 * Where the money went, biggest first.
 *
 * Uncategorized keeps its place in the ordering and is drawn muted rather than
 * accented — it is the size of the question still outstanding, and the panel
 * should make that easy to see without dressing it up as an answer.
 */
function CategoryBars({
  bars,
  currency,
  accountName,
}: {
  bars: FlowPanel["bars"];
  currency?: string;
  accountName: string;
}) {
  return (
    <section
      aria-label={`Expenses by category — ${accountName}`}
      className="border-hairline border-b px-4 py-4"
    >
      <MicroLabel as="h4" className="mb-3">
        Expenses by category
      </MicroLabel>

      {bars.length === 0 ? (
        <p className="text-muted text-[13px]">Nothing went out in this period.</p>
      ) : (
        <dl className="flex flex-col gap-2.5">
          {bars.map((bar) => (
            <div key={bar.categoryId ?? "uncategorized"} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <dt className={bar.categoryId === null ? "text-muted" : "text-ink"}>{bar.label}</dt>
                <dd className="text-ink shrink-0 tabular-nums">
                  {formatAmount(bar.amount, currency)}
                </dd>
              </div>
              {/* The bar is the `dd`'s figure at a glance, not a second datum —
                  hence no text of its own to read out twice. */}
              <div
                aria-hidden="true"
                className="bg-panel-2 h-1.5 w-full overflow-hidden rounded-full"
              >
                <div
                  className={`h-full rounded-full ${bar.categoryId === null ? "bg-muted" : "bg-accent"}`}
                  style={{ width: `${Math.max(bar.share * 100, 1)}%` }}
                />
              </div>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function TransactionList({
  transactions,
  categories,
  currency,
  accountName,
  openPicker,
  onOpenPicker,
  onPick,
  onCreate,
}: {
  transactions: readonly FlowTransaction[];
  categories: readonly CategoryRef[];
  currency?: string;
  accountName: string;
  openPicker: string | null;
  onOpenPicker: (transactionId: string | null) => void;
  onPick: (transaction: FlowTransaction, categoryId: string | null) => void;
  onCreate: (transaction: FlowTransaction, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? transactions : transactions.slice(0, VISIBLE_TRANSACTIONS);
  const hidden = transactions.length - visible.length;

  return (
    <section aria-label={`Transactions — ${accountName}`} className="px-4 py-4">
      <MicroLabel as="h4" className="mb-2">
        Transactions
      </MicroLabel>

      <ul className="flex flex-col">
        {visible.map((transaction) => (
          <li
            key={transaction.id}
            className="border-hairline flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0"
          >
            <span className="text-muted w-[84px] shrink-0 text-[12px] tabular-nums">
              {formatDay(transaction.day)}
            </span>
            <span className="text-ink min-w-[8rem] flex-1 truncate text-[13px]">
              {transaction.description}
              {transaction.pending ? <span className="text-muted"> · pending</span> : null}
            </span>
            <CategoryPicker
              transaction={transaction}
              categories={categories}
              open={openPicker === transaction.id}
              onOpenChange={onOpenPicker}
              onPick={onPick}
              onCreate={onCreate}
            />
            <span
              className={`w-[104px] shrink-0 text-right text-[13px] tabular-nums ${
                transaction.amount < 0 ? "text-ink" : "text-positive"
              }`}
            >
              {formatSignedAmount(transaction.amount, currency)}
            </span>
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="border-hairline text-muted hover:text-ink mt-3 rounded-md border px-3 py-1.5 text-[12px]"
        >
          Show all {transactions.length} transactions
        </button>
      ) : null}
    </section>
  );
}

/**
 * Click-to-open categorization: the categories that already exist, and the one
 * being typed if it doesn't.
 *
 * Picking from the list is the common case and creating is the exception, which
 * is why one input does both — the field filters what's there and only offers to
 * create once nothing matches. Re-typing a category name is exactly what the
 * shared `financials_category` table exists to avoid (spec #27).
 */
function CategoryPicker({
  transaction,
  categories,
  open,
  onOpenChange,
  onPick,
  onCreate,
}: {
  transaction: FlowTransaction;
  categories: readonly CategoryRef[];
  open: boolean;
  onOpenChange: (transactionId: string | null) => void;
  onPick: (transaction: FlowTransaction, categoryId: string | null) => void;
  onCreate: (transaction: FlowTransaction, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const wanted = query.trim();
  const matches = categories.filter((category) =>
    category.name.toLowerCase().includes(wanted.toLowerCase()),
  );
  // Case-insensitively, so "groceries" offers the existing Groceries rather than
  // proposing a near-duplicate the unique index would then reject.
  const exists = categories.some(
    (category) => category.name.toLowerCase() === wanted.toLowerCase(),
  );

  function close() {
    setQuery("");
    onOpenChange(null);
  }

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Category for ${transaction.description}`}
        onClick={() => (open ? close() : onOpenChange(transaction.id))}
        className={`border-hairline hover:border-accent rounded-full border px-2.5 py-0.5 text-[12px] ${
          transaction.categoryName ? "text-ink" : "text-muted"
        }`}
      >
        {transaction.categoryName ?? UNCATEGORIZED_LABEL}
      </button>

      {open ? (
        <>
          {/* Clicking anywhere else dismisses, which a popover has to do and a
              `blur` handler can't without stealing the click that follows it. */}
          <button
            type="button"
            aria-label="Close the category picker"
            onClick={close}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="group"
            aria-label={`Categories for ${transaction.description}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
            className="border-hairline bg-panel-2 absolute top-full right-0 z-20 mt-1 flex w-60 flex-col gap-2 rounded-md border p-2"
          >
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Find or name a category"
              placeholder="Find or name a category"
              className="border-hairline bg-panel text-ink placeholder:text-muted rounded border px-2 py-1 text-[13px]"
            />

            <ul className="flex max-h-44 flex-col overflow-y-auto">
              {matches.map((category) => (
                <li key={category.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      onPick(transaction, category.id);
                    }}
                    className={`hover:bg-panel w-full rounded px-2 py-1 text-left text-[13px] ${
                      category.id === transaction.categoryId ? "text-accent" : "text-ink"
                    }`}
                  >
                    {category.name}
                  </button>
                </li>
              ))}
            </ul>

            {matches.length === 0 && wanted === "" ? (
              <p className="text-muted px-2 py-1 text-[12px]">
                No categories yet — type a name to make the first one.
              </p>
            ) : null}

            {wanted !== "" && !exists ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  onCreate(transaction, wanted);
                }}
                className="text-accent hover:bg-panel rounded px-2 py-1 text-left text-[13px]"
              >
                Create “{wanted}”
              </button>
            ) : null}

            {transaction.categoryId !== null ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  onPick(transaction, null);
                }}
                className="border-hairline text-muted hover:text-ink rounded border-t px-2 pt-2 text-left text-[12px]"
              >
                Clear category
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </span>
  );
}

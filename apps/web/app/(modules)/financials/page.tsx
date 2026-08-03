import Link from "next/link";

import { FlowPanels } from "@/components/flow-panels";
import { NetWorthHero } from "@/components/net-worth-hero";
import type { CategoryRef, FlowAccountRef, FlowTransactionInput } from "@/lib/financials/flow";
import {
  buildNetWorthSeries,
  type AccountRef,
  type SnapshotInput,
} from "@/lib/financials/net-worth";
import { createClient } from "@/lib/supabase/server";

/**
 * The Financials module's front door: net worth as a trend, the equation saying
 * which accounts it is the sum of, and a flow panel per depository account.
 *
 * Everything shown here is derived at read time — net worth from
 * `financials_balance_snapshot`, flow from `financials_transaction` — so there
 * is no stored figure to go stale, and each surface's several renderings come
 * from one series rather than from calculations that have to be kept in step.
 */

export const dynamic = "force-dynamic";

/**
 * Enough snapshots for roughly a year and a half of twice-daily polling, and
 * newest-first so the bound eats the oldest history rather than the current
 * balance. Worth revisiting — as a daily rollup view — long before it bites.
 */
const SNAPSHOT_LIMIT = 1000;

/**
 * Newest-first for the same reason, and generous against what the tables can
 * actually hold: Bridge serves a bounded recent window, so the row count grows
 * only as fast as the sync accumulates it (ADR 0005).
 *
 * The bound is across *all* accounts, so it can be reached long before any one
 * panel looks short. Hitting it is passed down rather than swallowed — a period
 * quietly missing its oldest transactions would understate expenses, and an
 * understated expense figure is the one number here nobody would question.
 */
const TRANSACTION_LIMIT = 1000;

type AccountRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  currency: string;
};

type SnapshotRow = {
  account_id: string;
  balance: number | string;
  balance_date: string;
};

type TransactionRow = {
  id: string;
  account_id: string;
  posted: string;
  description: string;
  amount: number | string;
  pending: boolean;
  category_id: string | null;
};

type CategoryRow = {
  id: string;
  name: string;
};

export default async function FinancialsOverview() {
  // Four independent reads, issued together — the page is as slow as the
  // slowest, not as slow as their sum.
  const supabase = await createClient();

  const [accounts, snapshots, transactions, categories] = await Promise.all([
    supabase
      .from("financials_account")
      .select("id, name, kind, status, currency")
      .order("name")
      .returns<AccountRow[]>(),
    supabase
      .from("financials_balance_snapshot")
      .select("account_id, balance, balance_date")
      .order("balance_date", { ascending: false })
      .limit(SNAPSHOT_LIMIT)
      .returns<SnapshotRow[]>(),
    // Not filtered to the flow accounts: the accounts are only known once that
    // first query lands, and waiting for it would cost a round trip to save
    // sending the handful of rows a brokerage posts.
    supabase
      .from("financials_transaction")
      .select("id, account_id, posted, description, amount, pending, category_id")
      .order("posted", { ascending: false })
      .limit(TRANSACTION_LIMIT)
      .returns<TransactionRow[]>(),
    supabase.from("financials_category").select("id, name").order("name").returns<CategoryRow[]>(),
  ]);

  const error = accounts.error ?? snapshots.error ?? transactions.error ?? categories.error;

  const accountRefs: AccountRef[] = (accounts.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    // `status` is a free `text` column with a check constraint behind it; this
    // is the boundary that turns it into the two states the domain has. Anything
    // unrecognised counts as active — dropping a live account out of net worth
    // is the worse of the two ways to be wrong.
    status: row.status === "closed" ? "closed" : "active",
  }));

  // `kind` is read strictly, unlike `status`: the flow framing is only right for
  // an account someone has said is depository (ADR 0003 — no provider signals
  // it), and drawing income and expenses for a brokerage would be worse than
  // leaving it to the balance bridge that suits it.
  const flowAccounts: FlowAccountRef[] = (accounts.data ?? [])
    .filter((row) => row.kind === "depository")
    .map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status === "closed" ? "closed" : "active",
      currency: row.currency,
    }));

  const flowTransactions: FlowTransactionInput[] = (transactions.data ?? []).map((row) => ({
    id: row.id,
    accountId: row.account_id,
    posted: row.posted,
    description: row.description,
    amount: row.amount,
    pending: row.pending,
    categoryId: row.category_id,
  }));

  const categoryRefs: CategoryRef[] = categories.data ?? [];

  const snapshotInputs: SnapshotInput[] = (snapshots.data ?? []).map((row) => ({
    accountId: row.account_id,
    balance: row.balance,
    balanceDate: row.balance_date,
  }));

  const series = buildNetWorthSeries({ accounts: accountRefs, snapshots: snapshotInputs });

  return (
    <div className="flex flex-col gap-9">
      {error ? (
        <p className="border-hairline text-negative border-t pt-3 text-[13px]">
          Could not read the financials tables: {error.message}
        </p>
      ) : null}

      <NetWorthHero
        accounts={accountRefs}
        series={series}
        today={new Date().toISOString()}
        currency={sharedCurrency(accounts.data ?? [])}
      />

      <FlowPanels
        accounts={flowAccounts}
        transactions={flowTransactions}
        categories={categoryRefs}
        today={new Date().toISOString()}
        truncated={(transactions.data ?? []).length >= TRANSACTION_LIMIT}
      />

      <p className="border-hairline text-muted border-t pt-3 text-[13px]">
        <Link href="/financials/raw" className="hover:text-ink underline underline-offset-4">
          Raw sync data
        </Link>{" "}
        — the rows these figures are built from.
      </p>
    </div>
  );
}

/**
 * The currency to render totals in, or nothing when the accounts disagree.
 *
 * Summing across currencies is wrong, and v1 has one; the honest response to
 * more than one is to drop the symbol rather than stamp a total with a currency
 * that isn't what it means.
 */
function sharedCurrency(accounts: readonly AccountRow[]): string | undefined {
  const currencies = new Set(accounts.map((account) => account.currency));

  return currencies.size === 1 ? [...currencies][0] : undefined;
}

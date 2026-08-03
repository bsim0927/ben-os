import Link from "next/link";

import { NetWorthHero } from "@/components/net-worth-hero";
import {
  buildNetWorthSeries,
  type AccountRef,
  type SnapshotInput,
} from "@/lib/financials/net-worth";
import { createClient } from "@/lib/supabase/server";

/**
 * The Financials module's front door: net worth as a trend, and the equation
 * saying which accounts it is the sum of.
 *
 * Everything shown here is derived from `financials_balance_snapshot` at read
 * time — there is no stored net-worth figure to go stale, and the chart and the
 * equation strip are two renderings of one series rather than two calculations
 * that have to be kept in step.
 */

export const dynamic = "force-dynamic";

/**
 * Enough snapshots for roughly a year and a half of twice-daily polling, and
 * newest-first so the bound eats the oldest history rather than the current
 * balance. Worth revisiting — as a daily rollup view — long before it bites.
 */
const SNAPSHOT_LIMIT = 1000;

type AccountRow = {
  id: string;
  name: string;
  status: string;
  currency: string;
};

type SnapshotRow = {
  account_id: string;
  balance: number | string;
  balance_date: string;
};

export default async function FinancialsOverview() {
  const supabase = await createClient();

  const [accounts, snapshots] = await Promise.all([
    supabase
      .from("financials_account")
      .select("id, name, status, currency")
      .order("name")
      .returns<AccountRow[]>(),
    supabase
      .from("financials_balance_snapshot")
      .select("account_id, balance, balance_date")
      .order("balance_date", { ascending: false })
      .limit(SNAPSHOT_LIMIT)
      .returns<SnapshotRow[]>(),
  ]);

  const error = accounts.error ?? snapshots.error;

  const accountRefs: AccountRef[] = (accounts.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    // `status` is a free `text` column with a check constraint behind it; this
    // is the boundary that turns it into the two states the domain has. Anything
    // unrecognised counts as active — dropping a live account out of net worth
    // is the worse of the two ways to be wrong.
    status: row.status === "closed" ? "closed" : "active",
  }));

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

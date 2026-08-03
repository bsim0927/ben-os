import Link from "next/link";

import { MicroLabel, segmentedGroupClassName, segmentedItemClassName } from "@/components/console";
import { GainLoss, HoldingsLedger } from "@/components/holdings-ledger";
import { formatAmount, formatTimestamp } from "@/lib/financials/format";
import { buildHoldingsView, type HoldingSnapshotInput } from "@/lib/financials/holdings";
import { createClient } from "@/lib/supabase/server";

/**
 * `Financials / Holdings` — what one investment Account is actually made of.
 *
 * The drill-down the overview's bridge panel links to. The bridge explains why a
 * balance moved; this explains what the balance *is*, per security, which is the
 * one thing SimpleFIN cannot see and SnapTrade exists here to supply.
 *
 * Which account is being read lives in the URL rather than in component state,
 * so a particular account's holdings can be linked to, reloaded and gone back
 * to. Everything below the switcher is derived at read time from
 * `quantity × price` (ADR 0004 decision 3, ADR 0009) — there is no stored total
 * on any of these figures to drift from the rows underneath them.
 */

export const dynamic = "force-dynamic";

type AccountRow = {
  id: string;
  name: string;
  currency: string;
};

type HoldingRow = {
  account_id: string;
  security_id: string;
  quantity: number | string;
  average_cost_basis: number | string | null;
  market_price: number | string | null;
  currency: string | null;
  tax_lots: unknown;
  as_of: string;
  financials_security: { symbol: string; name: string | null; security_type: string } | null;
};

export default async function HoldingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const requested = (await searchParams).account;

  const accounts = await supabase
    .from("financials_account")
    .select("id, name, currency")
    .eq("kind", "investment")
    .order("name")
    .returns<AccountRow[]>();

  const investmentAccounts = accounts.data ?? [];
  // An unknown or absent `?account=` falls back to the first rather than
  // erroring: the page is reachable from the sidebar's own crumb trail and from
  // a stale bookmark, and neither deserves a dead end.
  const account =
    investmentAccounts.find((row) => row.id === requested) ?? investmentAccounts[0] ?? null;

  const holdings = account === null ? null : await readCurrentHoldings(supabase, account.id);

  // Built only when there is an account to build it for. An empty id would
  // resolve to an empty view, which renders identically — and is a figure this
  // page would then be claiming about an account that does not exist.
  const view =
    account === null
      ? null
      : buildHoldingsView({
          accountId: account.id,
          holdings: (holdings?.data ?? []).flatMap(toSnapshotInput),
        });

  const error = accounts.error ?? holdings?.error ?? null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-ink text-[15px] font-medium">
              {account ? account.name : "Holdings"}
            </h1>
            <p className="text-muted mt-1 text-[13px]">
              Every holding in this account as of its latest holdings sync. Values, cost basis and
              gain are computed from the rows below, not stored.
            </p>
          </div>

          {investmentAccounts.length > 1 ? (
            <nav aria-label="Account" className={segmentedGroupClassName}>
              {investmentAccounts.map((row) => (
                <Link
                  key={row.id}
                  href={`/financials/holdings?account=${encodeURIComponent(row.id)}`}
                  aria-current={row.id === account?.id ? "page" : undefined}
                  className={segmentedItemClassName(row.id === account?.id)}
                >
                  {row.name}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="border-hairline text-negative border-t pt-3 text-[13px]">
          Could not read the holdings tables: {error.message}
        </p>
      ) : null}

      {account === null || view === null ? (
        <p className="border-hairline text-muted border-t pt-3 text-[13px]">
          No investment accounts yet. An account becomes one when it is linked through
          SnapTrade&apos;s Connection Portal, which is what marks it as holding securities rather
          than cash.
        </p>
      ) : (
        <>
          <section
            aria-label="Summary"
            className="border-hairline bg-panel grid gap-px overflow-hidden rounded-md border sm:grid-cols-4"
          >
            <Figure label="Market value">
              {formatAmount(view.totalValue, view.currency ?? account.currency)}
            </Figure>
            <Figure label="Cost basis">
              {formatAmount(view.totalCostBasis, view.currency ?? account.currency)}
            </Figure>
            <Figure label="Unrealized gain/loss">
              <GainLoss
                gain={view.gain}
                ratio={view.gainRatio}
                currency={view.currency ?? account.currency}
              />
            </Figure>
            <Figure label="As of">
              <span className="text-muted">{formatTimestamp(view.asOf)}</span>
            </Figure>
          </section>

          {/*
           * Said only when it is true, and worth saying when it is: the strip's
           * figures are then sums over different subsets of the same account, so
           * `value − cost` will not equal the gain beside it and the gain's
           * percentage is against a cost basis other than the one shown.
           */}
          {view.pricedHoldings < view.holdings || view.costedHoldings < view.holdings ? (
            <p className="text-muted text-[12px]">
              {view.pricedHoldings < view.holdings
                ? `${view.holdings - view.pricedHoldings} of ${view.holdings} holdings came without a market price, so they are missing from the value above. `
                : ""}
              {view.costedHoldings < view.holdings
                ? `${view.holdings - view.costedHoldings} came without a cost basis, so the gain — and its percentage — is measured over the rest rather than reported as pure profit. Value minus cost will not equal it.`
                : ""}
            </p>
          ) : null}

          {/*
           * Dropping the currency symbol makes the figure honest about its units
           * and not about its arithmetic: the sum underneath still added two
           * currencies together. v1 has one currency, so this should never fire
           * — which is exactly why it says so rather than being left implicit.
           */}
          {view.mixedCurrency ? (
            <p className="border-hairline text-negative border-t pt-3 text-[12px]">
              These holdings are priced in more than one currency. The totals above add them
              together without converting, so they are not a figure to rely on.
            </p>
          ) : null}

          <HoldingsLedger view={view} accountName={account.name} />
        </>
      )}

      <p className="border-hairline text-muted border-t pt-3 text-[13px]">
        <Link href="/financials" className="hover:text-ink underline underline-offset-4">
          Back to Financials
        </Link>{" "}
        — net worth, flow, and the balance bridge these holdings sit inside.
      </p>
    </div>
  );
}

/**
 * This account's most recent reading, in two queries rather than one bounded
 * one.
 *
 * `financials_holding` is append-on-sync (ADR 0004 decision 1), so a single
 * `order by as_of desc limit N` would work right up until an account held more
 * than N holdings — at which point the newest snapshot would be cut in half and
 * every total on this page would quietly be short a holding. Asking for the
 * latest `as_of` first and then for exactly that reading has no such bound: the
 * second query returns one snapshot, whatever its size.
 *
 * The two are sequential because the second needs the first's answer. That is
 * the cost of the correctness, and it is one round trip on a drill-down page.
 */
async function readCurrentHoldings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
) {
  const latest = await supabase
    .from("financials_holding")
    .select("as_of")
    .eq("account_id", accountId)
    .order("as_of", { ascending: false })
    .limit(1)
    .returns<{ as_of: string }[]>();

  const asOf = latest.data?.[0]?.as_of;

  if (latest.error || asOf === undefined) {
    return { data: [] as HoldingRow[], error: latest.error };
  }

  return supabase
    .from("financials_holding")
    .select(
      "account_id, security_id, quantity, average_cost_basis, market_price, currency, tax_lots, as_of, financials_security ( symbol, name, security_type )",
    )
    .eq("account_id", accountId)
    .eq("as_of", asOf)
    .returns<HoldingRow[]>();
}

/**
 * A row, once it has a security to be a holding *of*.
 *
 * A join that came back empty drops the row rather than inventing a symbol for
 * it: `security_id` is a non-null foreign key, so this only happens if RLS hid
 * the security or the select changed shape, and a holding labelled "—" in every
 * column would be worse than one that is honestly not there.
 */
function toSnapshotInput(row: HoldingRow): HoldingSnapshotInput[] {
  const security = row.financials_security;

  if (security === null) return [];

  return [
    {
      accountId: row.account_id,
      securityId: row.security_id,
      symbol: security.symbol,
      securityName: security.name,
      securityType: security.security_type,
      quantity: row.quantity,
      averageCostBasis: row.average_cost_basis,
      marketPrice: row.market_price,
      currency: row.currency,
      taxLots: row.tax_lots,
      asOf: row.as_of,
    },
  ];
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel outline-hairline px-4 py-3 outline">
      <MicroLabel as="h2">{label}</MicroLabel>
      <p className="text-ink mt-1.5 text-[15px] tabular-nums">{children}</p>
    </div>
  );
}

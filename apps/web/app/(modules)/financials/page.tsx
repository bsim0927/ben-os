import { MicroLabel } from "@/components/console";
import { createClient } from "@/lib/supabase/server";

/**
 * The raw data the SimpleFIN sync produced — accounts, balance snapshots, and
 * transactions, as rows.
 *
 * Deliberately unfinished. Its job is to make sync correctness *visible*: that
 * an overlapping poll didn't duplicate a transaction, that a snapshot landed for
 * every account, that a broken institution didn't take the others with it. The
 * designed Financials surfaces — net worth, the flow view, the balance bridge —
 * are later tickets, and none of them can be trusted before this one reads right.
 *
 * Everything here is fetched through the anon key and the signed-in session, so
 * these tables are also a live check that the RLS policies admit the authorized
 * user rather than only that they reject everyone else.
 */

export const dynamic = "force-dynamic";

const RECENT_LIMIT = 50;

type ConnectionRef = { name: string; provider: string } | null;

type AccountRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  currency: string;
  balance: number | string;
  available_balance: number | string | null;
  balance_date: string | null;
  provider_account_id: string;
  financials_connection: ConnectionRef;
};

type SnapshotRow = {
  id: string;
  balance: number | string;
  available_balance: number | string | null;
  balance_date: string;
  financials_account: { name: string } | null;
};

type TransactionRow = {
  id: string;
  posted: string;
  description: string;
  amount: number | string;
  pending: boolean;
  provider_transaction_id: string;
  financials_account: { name: string } | null;
};

export default async function FinancialsRawData() {
  const supabase = await createClient();

  // Issued together: three independent reads, and awaiting them in sequence
  // would make the page as slow as their sum for no reason.
  const [accounts, snapshots, transactions] = await Promise.all([
    supabase
      .from("financials_account")
      .select(
        "id, name, kind, status, currency, balance, available_balance, balance_date, provider_account_id, financials_connection ( name, provider )",
      )
      .order("name")
      .returns<AccountRow[]>(),
    supabase
      .from("financials_balance_snapshot")
      .select("id, balance, available_balance, balance_date, financials_account ( name )")
      .order("balance_date", { ascending: false })
      .limit(RECENT_LIMIT)
      .returns<SnapshotRow[]>(),
    supabase
      .from("financials_transaction")
      .select(
        "id, posted, description, amount, pending, provider_transaction_id, financials_account ( name )",
      )
      .order("posted", { ascending: false })
      .limit(RECENT_LIMIT)
      .returns<TransactionRow[]>(),
  ]);

  const error = accounts.error ?? snapshots.error ?? transactions.error;

  return (
    <div className="flex flex-col gap-9">
      <section>
        <h1 className="text-ink text-[15px] font-medium">Raw sync data</h1>
        <p className="text-muted mt-1 text-[13px]">
          What the scheduled SimpleFIN poll has written. Unstyled on purpose — this is the check
          that sync is correct, not the Financials module&apos;s real surface.
        </p>
      </section>

      {error ? (
        <p className="border-hairline text-negative border-t pt-3 text-[13px]">
          Could not read the financials tables: {error.message}
        </p>
      ) : null}

      <Section label={`Accounts (${accounts.data?.length ?? 0})`}>
        <Table
          columns={["Account", "Connection", "Kind", "Status", "Balance", "Available", "As of"]}
          rows={(accounts.data ?? []).map((row) => [
            <span key="n" title={row.provider_account_id}>
              {row.name}
            </span>,
            row.financials_connection?.name ?? "—",
            row.kind,
            row.status,
            <Amount key="b" value={row.balance} currency={row.currency} signed={false} />,
            row.available_balance === null ? (
              "—"
            ) : (
              <Amount
                key="a"
                value={row.available_balance}
                currency={row.currency}
                signed={false}
              />
            ),
            formatTimestamp(row.balance_date),
          ])}
          empty="No accounts synced yet."
        />
      </Section>

      <Section label={`Balance snapshots — ${RECENT_LIMIT} most recent`}>
        <Table
          columns={["Account", "Balance", "Available", "Balance date"]}
          rows={(snapshots.data ?? []).map((row) => [
            row.financials_account?.name ?? "—",
            <Amount key="b" value={row.balance} signed={false} />,
            row.available_balance === null ? (
              "—"
            ) : (
              <Amount key="a" value={row.available_balance} signed={false} />
            ),
            formatTimestamp(row.balance_date),
          ])}
          empty="No balance snapshots yet."
        />
      </Section>

      <Section label={`Transactions — ${RECENT_LIMIT} most recent`}>
        <Table
          columns={["Posted", "Account", "Description", "Amount", "State"]}
          rows={(transactions.data ?? []).map((row) => [
            formatTimestamp(row.posted),
            row.financials_account?.name ?? "—",
            <span key="d" title={row.provider_transaction_id}>
              {row.description}
            </span>,
            <Amount key="a" value={row.amount} />,
            row.pending ? "pending" : "posted",
          ])}
          empty="No transactions yet."
        />
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <MicroLabel className="mb-3">{label}</MicroLabel>
      {children}
    </section>
  );
}

function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="border-hairline text-muted border-t pt-3 text-[13px]">{empty}</p>;
  }

  return (
    // Wide on a narrow viewport is the table's problem to solve, not the page's.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className="border-hairline border-b">
            {columns.map((column) => (
              <th
                key={column}
                className="text-muted px-2 py-2 text-left text-[11px] font-normal tracking-[0.08em] uppercase first:pl-0 last:pr-0"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, index) => (
            <tr key={index} className="border-hairline text-ink border-b last:border-b-0">
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-2 first:pl-0 last:pr-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `signed` is off for balances and on for transaction amounts: a negative
 * balance is just a number, but a transaction's sign is the whole meaning
 * (positive = money in, per SimpleFIN's convention), so it earns the colour.
 */
function Amount({
  value,
  currency,
  signed = true,
}: {
  value: number | string;
  currency?: string;
  signed?: boolean;
}) {
  const numeric = typeof value === "number" ? value : Number.parseFloat(value);
  const tone = !signed ? "" : numeric < 0 ? "text-negative" : "text-positive";
  // A currency that isn't ISO 4217 — SimpleFIN allows a URL — would throw
  // Intl, so anything unrecognised falls back to the plain number.
  const formatted = formatAmount(numeric, currency);

  return <span className={`tabular-nums ${tone}`.trim()}>{formatted}</span>;
}

function formatAmount(value: number, currency?: string): string {
  if (Number.isNaN(value)) return "—";

  if (currency && /^[A-Z]{3}$/.test(currency)) {
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

function formatTimestamp(value: string | null): string {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  // UTC throughout: the sync's own timestamps are UTC, and a page that silently
  // reinterpreted them in the viewer's zone would make an off-by-hours balance
  // date look like a sync bug.
  return date.toISOString().replace("T", " ").slice(0, 16);
}

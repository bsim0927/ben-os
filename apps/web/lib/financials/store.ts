/**
 * Every write the sync job makes, as SQL.
 *
 * Built over a bare query function rather than a `pg.Pool` so the caller decides
 * what the statements run against — a pooled connection in the cron route, a
 * per-test connection in the suite. Both run the same SQL against a real
 * Postgres with RLS active; there is no in-memory stand-in for this, on purpose,
 * because the parts most worth testing (the upsert keys, the prune predicate)
 * are the SQL itself.
 */

import type { PollWindow } from "./simplefin";

export type QueryResult = { rows: Record<string, unknown>[] };
export type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

export type ConnectionInput = {
  provider: string;
  providerConnId: string;
  name: string;
  orgId: string | null;
  extra: Record<string, unknown> | null;
};

export type AccountInput = {
  connectionId: string;
  providerAccountId: string;
  name: string;
  currency: string;
  balance: string;
  availableBalance: string | null;
  balanceDate: Date | null;
  extra: Record<string, unknown> | null;
};

export type BalanceSnapshotInput = {
  accountId: string;
  balance: string;
  availableBalance: string | null;
  balanceDate: Date;
};

export type TransactionInput = {
  providerTransactionId: string;
  posted: Date;
  transactedAt: Date | null;
  amount: string;
  description: string;
  pending: boolean;
  extra: Record<string, unknown> | null;
};

export type FinancialsStore = ReturnType<typeof createFinancialsStore>;

export function createFinancialsStore(query: QueryFn) {
  return {
    /**
     * Whether this database has ever recorded a transaction — the signal the
     * sync uses to tell a first poll from a routine one. Deliberately not "are
     * there accounts": an account row can exist from a poll that returned
     * balances and no feed, which is exactly when the wide first window is still
     * owed.
     */
    async hasAnyTransactions(): Promise<boolean> {
      const { rows } = await query(
        "select exists (select 1 from public.financials_transaction) as any_rows",
      );

      return rows[0].any_rows === true;
    },

    async upsertConnection(input: ConnectionInput): Promise<string> {
      const { rows } = await query(
        `insert into public.financials_connection (provider, provider_conn_id, name, org_id, extra)
         values ($1, $2, $3, $4, $5)
         on conflict (provider, provider_conn_id) do update
           set name = excluded.name,
               org_id = excluded.org_id,
               extra = excluded.extra
         returning id`,
        [input.provider, input.providerConnId, input.name, input.orgId, asJson(input.extra)],
      );

      return rows[0].id as string;
    },

    /**
     * `kind` and `status` are pointedly absent from the update list. Both are
     * user-owned — `kind` because no provider signals it (ADR 0003), `status`
     * because closure is a decision the user records (ADR 0002) — so a sync that
     * wrote them would undo the user on every poll.
     */
    async upsertAccount(input: AccountInput): Promise<string> {
      const { rows } = await query(
        `insert into public.financials_account
           (connection_id, provider_account_id, name, currency, balance,
            available_balance, balance_date, extra)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (connection_id, provider_account_id) do update
           set name = excluded.name,
               currency = excluded.currency,
               balance = excluded.balance,
               available_balance = excluded.available_balance,
               balance_date = excluded.balance_date,
               extra = excluded.extra
         returning id`,
        [
          input.connectionId,
          input.providerAccountId,
          input.name,
          input.currency,
          input.balance,
          input.availableBalance,
          input.balanceDate,
          asJson(input.extra),
        ],
      );

      return rows[0].id as string;
    },

    async insertBalanceSnapshot(input: BalanceSnapshotInput): Promise<void> {
      await query(
        `insert into public.financials_balance_snapshot
           (account_id, balance, available_balance, balance_date)
         values ($1, $2, $3, $4)`,
        [input.accountId, input.balance, input.availableBalance, input.balanceDate],
      );
    },

    /**
     * One statement for the whole batch, unnesting parallel arrays — a poll can
     * carry hundreds of transactions and a round trip each would dominate the
     * job's runtime.
     *
     * `category_id` is never written here: it is the user's, and re-syncing an
     * overlapping window must not erase a category they assigned.
     */
    async upsertTransactions(
      accountId: string,
      transactions: TransactionInput[],
      syncedAt: Date,
    ): Promise<number> {
      if (transactions.length === 0) return 0;

      const { rows } = await query(
        `insert into public.financials_transaction
           (account_id, provider_transaction_id, posted, transacted_at, amount,
            description, pending, extra, last_synced_at)
         select $1, t.provider_transaction_id, t.posted, t.transacted_at, t.amount,
                t.description, t.pending, t.extra, $2
           from unnest($3::text[], $4::timestamptz[], $5::timestamptz[], $6::numeric[],
                       $7::text[], $8::boolean[], $9::jsonb[])
             as t(provider_transaction_id, posted, transacted_at, amount,
                  description, pending, extra)
         on conflict (account_id, provider_transaction_id) do update
           set posted = excluded.posted,
               transacted_at = excluded.transacted_at,
               amount = excluded.amount,
               description = excluded.description,
               pending = excluded.pending,
               extra = excluded.extra,
               last_synced_at = excluded.last_synced_at
         returning id`,
        [
          accountId,
          syncedAt,
          transactions.map((t) => t.providerTransactionId),
          transactions.map((t) => t.posted),
          transactions.map((t) => t.transactedAt),
          transactions.map((t) => t.amount),
          transactions.map((t) => t.description),
          transactions.map((t) => t.pending),
          transactions.map((t) => asJson(t.extra)),
        ],
      );

      return rows.length;
    },

    /**
     * Drops pending transactions the provider stopped reporting.
     *
     * A pending transaction routinely re-posts under a *different* provider id,
     * so the old row can never be matched to its replacement — left alone it
     * would double-count against the posted one forever. `last_synced_at` older
     * than this run is the evidence it was absent from a poll that covered it,
     * which is the only thing distinguishing "gone" from "outside the window".
     *
     * Scoped to the window actually fetched: a pending row older than
     * `windowStart` was not looked for, and absence of evidence is not evidence.
     */
    async prunePendingTransactions(
      accountId: string,
      window: PollWindow,
      syncedAt: Date,
    ): Promise<number> {
      const { rows } = await query(
        `delete from public.financials_transaction
          where account_id = $1
            and pending
            and posted >= $2
            and posted < $3
            and last_synced_at < $4
          returning id`,
        [accountId, window.startDate, window.endDate, syncedAt],
      );

      return rows.length;
    },
  };
}

/** node-pg sends objects as-is; jsonb columns want the serialized form. */
function asJson(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

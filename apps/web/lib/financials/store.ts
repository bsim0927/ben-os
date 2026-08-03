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
import { SNAPTRADE_PROVIDER } from "./snaptrade";

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

export type SecurityInput = {
  symbol: string;
  name: string | null;
  securityType: string;
  extra: Record<string, unknown> | null;
};

export type HoldingInput = {
  accountId: string;
  securityId: string;
  /** Decimal strings, not numbers: these land in `numeric` columns. */
  quantity: string;
  averageCostBasis: string | null;
  marketPrice: string | null;
  currency: string | null;
  taxLots: unknown[] | null;
  extra: Record<string, unknown> | null;
  asOf: Date;
};

export type SnapTradeConnectionInput = {
  /** SnapTrade's persistent connection identity, from the Connection Portal. */
  authorizationId: string;
  name: string;
  /** SnapTrade account id → `financials_account.id`. See `readSnapTradeConnection`. */
  accountLinks: Record<string, string>;
};

export type SnapTradeConnection = {
  authorizationId: string;
  accountLinks: Record<string, string>;
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

    // -----------------------------------------------------------------------
    // SnapTrade holdings
    // -----------------------------------------------------------------------

    /**
     * The SnapTrade connection, if one has been linked, with the account map
     * that says which local account each SnapTrade account *is*.
     *
     * That map is the whole reason this is not symmetrical with SimpleFIN. Both
     * providers report the same two Fidelity accounts, and inserting a second
     * `financials_account` row for one would count it twice in net worth. So
     * SnapTrade never creates accounts: it attaches holdings to the rows
     * SimpleFIN already syncs, and the link is recorded here — user-owned data,
     * the same category as `financials_account.kind`, because no provider can
     * tell you that its account id and SimpleFIN's name the same account.
     *
     * Singular because Personal mode has one API key, and one key is one
     * SnapTrade user. A second brokerage arrives as a second authorization
     * under the same key, which is a change to this query, not to the schema.
     */
    async readSnapTradeConnection(): Promise<SnapTradeConnection | null> {
      const { rows } = await query(
        `select provider_conn_id, extra
           from public.financials_connection
          where provider = $1
          order by created_at
          limit 1`,
        [SNAPTRADE_PROVIDER],
      );

      if (rows.length === 0) return null;

      const extra = (rows[0].extra ?? {}) as { accounts?: unknown };
      const accounts = extra.accounts;

      return {
        authorizationId: rows[0].provider_conn_id as string,
        // Tolerated rather than trusted: this column is jsonb, so a hand-edited
        // row can hold anything, and a malformed map should mean "nothing is
        // linked" rather than a crash halfway through a sync.
        accountLinks:
          accounts !== null && typeof accounts === "object" && !Array.isArray(accounts)
            ? Object.fromEntries(
                Object.entries(accounts as Record<string, unknown>).filter(
                  ([, value]) => typeof value === "string",
                ) as [string, string][],
              )
            : {},
      };
    },

    /**
     * Every account a SnapTrade account could be linked *to*, for the link
     * route to show alongside what SnapTrade reports.
     *
     * Not filtered to `kind = 'investment'`: the account this app most expects
     * to link is a brokerage account whose `kind` is still the `depository`
     * default, and hiding it would make the one thing the route exists to fix
     * invisible from the route that fixes it.
     */
    async listLinkableAccounts(): Promise<
      { id: string; name: string; kind: string; provider: string; connection: string }[]
    > {
      const { rows } = await query(
        `select a.id, a.name, a.kind, c.provider, c.name as connection
           from public.financials_account a
           join public.financials_connection c on c.id = a.connection_id
          where a.status = 'active'
          order by c.name, a.name`,
      );

      return rows as {
        id: string;
        name: string;
        kind: string;
        provider: string;
        connection: string;
      }[];
    },

    async upsertSnapTradeConnection(input: SnapTradeConnectionInput): Promise<string> {
      const { rows } = await query(
        `insert into public.financials_connection (provider, provider_conn_id, name, extra)
         values ($1, $2, $3, $4)
         on conflict (provider, provider_conn_id) do update
           set name = excluded.name,
               extra = excluded.extra
         returning id`,
        [
          SNAPTRADE_PROVIDER,
          input.authorizationId,
          input.name,
          asJson({ authorization_id: input.authorizationId, accounts: input.accountLinks }),
        ],
      );

      return rows[0].id as string;
    },

    /**
     * Marks an account as one whose contents are holdings.
     *
     * The one place anything writes `kind`, and it is not the sync: linking is a
     * user action, and ADR 0003 makes `kind` user-set precisely because no
     * provider signals it. Pointing the Connection Portal at an account *is* the
     * user saying it is a brokerage account, so that assertion is recorded here
     * rather than left for them to repeat somewhere else.
     */
    async markAccountInvestment(accountId: string): Promise<boolean> {
      const { rows } = await query(
        `update public.financials_account set kind = 'investment' where id = $1 returning id`,
        [accountId],
      );

      return rows.length === 1;
    },

    /**
     * Reference data for one security, keyed on its ticker (ADR 0004 decision 2).
     *
     * Updates name and type on conflict: a security's description genuinely
     * changes, and unlike `financials_account.kind` there is no user-owned field
     * on this table for a sync to trample.
     */
    async upsertSecurity(input: SecurityInput): Promise<string> {
      const { rows } = await query(
        `insert into public.financials_security (symbol, name, security_type, extra)
         values ($1, $2, $3, $4)
         on conflict (symbol) do update
           set name = excluded.name,
               security_type = excluded.security_type,
               extra = excluded.extra
         returning id`,
        [input.symbol, input.name, input.securityType, asJson(input.extra)],
      );

      return rows[0].id as string;
    },

    /**
     * Appends this sync's holdings, one statement for the account's whole
     * portfolio.
     *
     * `do nothing` rather than `do update` is what makes a retry cost nothing:
     * `as_of` is the provider's own reading time, so a second run against an
     * unchanged reading collides on every row and writes none. It also absorbs a
     * brokerage reporting the same ticker twice in one response, which `do
     * update` would reject outright.
     */
    async insertHoldings(holdings: HoldingInput[]): Promise<number> {
      if (holdings.length === 0) return 0;

      const { rows } = await query(
        `insert into public.financials_holding
           (account_id, security_id, quantity, average_cost_basis, market_price,
            currency, tax_lots, extra, as_of)
         select h.account_id, h.security_id, h.quantity, h.average_cost_basis, h.market_price,
                h.currency, h.tax_lots, h.extra, h.as_of
           from unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::numeric[], $5::numeric[],
                       $6::text[], $7::jsonb[], $8::jsonb[], $9::timestamptz[])
             as h(account_id, security_id, quantity, average_cost_basis, market_price,
                  currency, tax_lots, extra, as_of)
         on conflict (account_id, security_id, as_of) do nothing
         returning id`,
        [
          holdings.map((h) => h.accountId),
          holdings.map((h) => h.securityId),
          holdings.map((h) => h.quantity),
          holdings.map((h) => h.averageCostBasis),
          holdings.map((h) => h.marketPrice),
          holdings.map((h) => h.currency),
          holdings.map((h) => (h.taxLots === null ? null : JSON.stringify(h.taxLots))),
          holdings.map((h) => asJson(h.extra)),
          holdings.map((h) => h.asOf),
        ],
      );

      return rows.length;
    },
  };
}

/** node-pg sends objects as-is; jsonb columns want the serialized form. */
function asJson(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

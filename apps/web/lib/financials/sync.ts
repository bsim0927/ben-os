/**
 * The scheduled SimpleFIN sync.
 *
 * One `GET /accounts` call covers every connection on the subscription, so the
 * job's shape is: fetch once, then fan the response out per connection. The
 * fanning-out is where the care is — a poll routinely succeeds for one
 * institution and fails for another, and the whole point of `errlist` is that
 * those are separate outcomes.
 */

import {
  createSimpleFinClient,
  errorScope,
  fromEpochSeconds,
  pollWindow,
  type SimpleFinAccount,
  type SimpleFinClient,
  type SimpleFinConnection,
  type SimpleFinError,
  type SimpleFinTransaction,
} from "./simplefin";
import type { UnitOfWork } from "./db";
import { createFinancialsStore, type FinancialsStore, type TransactionInput } from "./store";

export const SIMPLEFIN_PROVIDER = "simplefin";

export type ConnectionSyncResult = {
  providerConnId: string;
  name: string;
  status: "synced" | "failed";
  accounts: number;
  transactionsUpserted: number;
  pendingPruned: number;
  snapshotsWritten: number;
  /** Errors SimpleFIN reported against this connection or its accounts. */
  errors: SimpleFinError[];
  /** Set only when this connection's own writes threw. */
  failure?: string;
};

export type SyncResult = {
  startedAt: string;
  window: { startDate: string; endDate: string };
  connections: ConnectionSyncResult[];
  /** `gen`-scoped errors — quota warnings and the like, not tied to one bank. */
  generalErrors: SimpleFinError[];
};

export type SyncOptions = {
  client: SimpleFinClient;
  /** One transaction per connection — see `UnitOfWork` for why that granularity. */
  unitOfWork: UnitOfWork;
  now?: Date;
  overlapDays?: number;
};

/** Convenience wrapper for callers holding an Access URL rather than a client. */
export function simpleFinClientFor(accessUrl: string): SimpleFinClient {
  return createSimpleFinClient(accessUrl);
}

export async function syncSimpleFin({
  client,
  unitOfWork,
  now = new Date(),
  overlapDays,
}: SyncOptions): Promise<SyncResult> {
  const window = pollWindow(now, overlapDays);

  // Every row this run touches is stamped with the same instant, which is what
  // makes "not seen this run" a decidable question during pruning.
  const syncedAt = now;

  const accountSet = await client.fetchAccountSet({ ...window, pending: true });

  const accountsByConn = groupBy(accountSet.accounts, (account) => account.conn_id);
  const connectionsByConnId = new Map(accountSet.connections.map((c) => [c.conn_id, c]));
  const errors = partitionErrors(accountSet.errlist, accountSet.accounts);

  // The union of both sources, not just `connections`: a connection that failed
  // hard may be absent from one list or the other, and it still needs a result
  // row rather than vanishing from the report.
  const connIds = [
    ...new Set([...connectionsByConnId.keys(), ...accountsByConn.keys(), ...errors.byConn.keys()]),
  ];

  const results: ConnectionSyncResult[] = [];

  for (const connId of connIds) {
    const meta = connectionsByConnId.get(connId);
    const accounts = accountsByConn.get(connId) ?? [];
    const connErrors = errors.byConn.get(connId) ?? [];

    try {
      const counts = await unitOfWork((query) =>
        syncConnection({
          store: createFinancialsStore(query),
          connId,
          meta,
          accounts,
          window,
          syncedAt,
        }),
      );

      results.push({
        providerConnId: connId,
        name: meta?.name ?? connId,
        status: "synced",
        errors: connErrors,
        ...counts,
      });
    } catch (cause) {
      // Caught per connection, deliberately: one institution's broken data must
      // not cost every other institution its sync.
      results.push({
        providerConnId: connId,
        name: meta?.name ?? connId,
        status: "failed",
        accounts: 0,
        transactionsUpserted: 0,
        pendingPruned: 0,
        snapshotsWritten: 0,
        errors: connErrors,
        failure: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return {
    startedAt: syncedAt.toISOString(),
    window: {
      startDate: window.startDate.toISOString(),
      endDate: window.endDate.toISOString(),
    },
    connections: results,
    generalErrors: errors.general,
  };
}

async function syncConnection({
  store,
  connId,
  meta,
  accounts,
  window,
  syncedAt,
}: {
  store: FinancialsStore;
  connId: string;
  meta: SimpleFinConnection | undefined;
  accounts: SimpleFinAccount[];
  window: { startDate: Date; endDate: Date };
  syncedAt: Date;
}) {
  const connectionId = await store.upsertConnection({
    provider: SIMPLEFIN_PROVIDER,
    providerConnId: connId,
    // A connection known only from an account's `conn_id` has no name to show;
    // the id is a worse label than the institution's name but better than a
    // missing row.
    name: meta?.name ?? connId,
    orgId: meta?.org_id ?? null,
    extra: meta ? { sfin_url: meta.sfin_url, org_url: meta.org_url ?? null } : null,
  });

  let transactionsUpserted = 0;
  let pendingPruned = 0;
  let snapshotsWritten = 0;

  for (const account of accounts) {
    const accountId = await store.upsertAccount({
      connectionId,
      providerAccountId: account.id,
      name: account.name,
      currency: account.currency,
      balance: account.balance,
      availableBalance: account["available-balance"] ?? null,
      balanceDate: fromEpochSeconds(account["balance-date"]),
      extra: account.extra ?? null,
    });

    // Written every poll regardless of whether any transaction moved: net worth
    // history is a series of observations, and a quiet day is still one.
    await store.insertBalanceSnapshot({
      accountId,
      balance: account.balance,
      availableBalance: account["available-balance"] ?? null,
      balanceDate: fromEpochSeconds(account["balance-date"]),
    });
    snapshotsWritten += 1;

    transactionsUpserted += await store.upsertTransactions(
      accountId,
      (account.transactions ?? []).map(toTransactionInput),
      syncedAt,
    );

    // Only for accounts this poll actually returned. An account missing from the
    // response was never looked at, so nothing about it can be pruned.
    pendingPruned += await store.prunePendingTransactions(accountId, window, syncedAt);
  }

  return {
    accounts: accounts.length,
    transactionsUpserted,
    pendingPruned,
    snapshotsWritten,
  };
}

function toTransactionInput(transaction: SimpleFinTransaction): TransactionInput {
  return {
    providerTransactionId: transaction.id,
    posted: fromEpochSeconds(transaction.posted),
    transactedAt:
      transaction.transacted_at === undefined ? null : fromEpochSeconds(transaction.transacted_at),
    amount: transaction.amount,
    description: transaction.description ?? "",
    pending: transaction.pending ?? false,
    extra: transaction.extra ?? null,
  };
}

/**
 * Splits `errlist` into the connection it spoils and the poll-wide remainder.
 *
 * An `act`-scoped error names an account, not a connection, so it is attributed
 * through the account it names — otherwise a single broken account would report
 * as a general failure and look like everything was down.
 */
function partitionErrors(
  errlist: SimpleFinError[],
  accounts: SimpleFinAccount[],
): { byConn: Map<string, SimpleFinError[]>; general: SimpleFinError[] } {
  const connIdByAccountId = new Map(accounts.map((account) => [account.id, account.conn_id]));
  const byConn = new Map<string, SimpleFinError[]>();
  const general: SimpleFinError[] = [];

  for (const error of errlist) {
    const scope = errorScope(error);
    const connId =
      scope === "connection"
        ? error.conn_id
        : scope === "account" && error.account_id
          ? connIdByAccountId.get(error.account_id)
          : undefined;

    if (connId) {
      byConn.set(connId, [...(byConn.get(connId) ?? []), error]);
    } else {
      general.push(error);
    }
  }

  return { byConn, general };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();

  for (const item of items) {
    const k = key(item);
    grouped.set(k, [...(grouped.get(k) ?? []), item]);
  }

  return grouped;
}

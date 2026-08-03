/**
 * The scheduled SnapTrade holdings sync.
 *
 * Shaped differently from the SimpleFIN sync, and the difference is the point.
 * SimpleFIN's job is to *discover* accounts: one call returns everything on the
 * subscription and the sync writes whatever it finds. This job discovers
 * nothing. Both Fidelity accounts already exist in this database, synced from
 * SimpleFIN, and a second row for either would count it twice in net worth — so
 * SnapTrade contributes only the thing SimpleFIN cannot see, the per-security
 * positions inside an account it is told about.
 *
 * That makes the unit of work an *account* rather than a connection: one HTTP
 * call and one transaction each, so a brokerage that answers for one account and
 * not the other still gets the one written. Same reasoning as ADR 0005 decision
 * 3, one level down, because that is where the failures land here.
 */

import { messageFor } from "@/lib/errors";

import type { UnitOfWork } from "./db";
import {
  holdingsAsOf,
  positionSymbol,
  securityTypeFor,
  type SnapTradeClient,
  type SnapTradeHoldings,
} from "./snaptrade";
import { createFinancialsStore, type FinancialsStore, type HoldingInput } from "./store";

export type AccountHoldingsResult = {
  snapTradeAccountId: string;
  /** The `financials_account` row the holdings were attached to. */
  accountId: string;
  status: "synced" | "failed";
  /** The provider's reading time these holdings were stamped with. */
  asOf: string | null;
  /** Positions SnapTrade reported, including any that were skipped. */
  positions: number;
  holdingsInserted: number;
  /** Positions with no ticker or no quantity — nothing to key a holding on. */
  skipped: number;
  /** Set only when this account's fetch or writes threw. */
  failure?: string;
};

export type HoldingsSyncResult = {
  startedAt: string;
  /**
   * `not-linked` is a resting state, not an error: the Connection Portal flow is
   * a human sitting at a browser, and until they have finished it there is
   * nothing for the schedule to do.
   */
  status: "synced" | "not-linked";
  accounts: AccountHoldingsResult[];
};

export type HoldingsSyncOptions = {
  client: SnapTradeClient;
  /** One transaction per account — see the module comment for why that unit. */
  unitOfWork: UnitOfWork;
  now?: Date;
};

export async function syncSnapTradeHoldings({
  client,
  unitOfWork,
  now = new Date(),
}: HoldingsSyncOptions): Promise<HoldingsSyncResult> {
  const startedAt = now.toISOString();

  const connection = await unitOfWork((query) =>
    createFinancialsStore(query).readSnapTradeConnection(),
  );

  const links = Object.entries(connection?.accountLinks ?? {});

  if (links.length === 0) {
    return { startedAt, status: "not-linked", accounts: [] };
  }

  const accounts: AccountHoldingsResult[] = [];

  for (const [snapTradeAccountId, accountId] of links) {
    try {
      // Fetched outside the transaction on purpose: a slow brokerage would
      // otherwise hold a database connection open for the length of an HTTP
      // round trip, and there is nothing to roll back if the fetch fails.
      const holdings = await client.fetchHoldings(snapTradeAccountId);
      const asOf = holdingsAsOf(holdings.account, now);

      const counts = await unitOfWork((query) =>
        writeHoldings({ store: createFinancialsStore(query), accountId, holdings, asOf }),
      );

      accounts.push({
        snapTradeAccountId,
        accountId,
        status: "synced",
        asOf: asOf.toISOString(),
        ...counts,
      });
    } catch (cause) {
      // Caught per account, deliberately: one broken account must not cost the
      // others their sync, and a rate limit on the third call must not discard
      // the first two.
      accounts.push({
        snapTradeAccountId,
        accountId,
        status: "failed",
        asOf: null,
        positions: 0,
        holdingsInserted: 0,
        skipped: 0,
        failure: messageFor(cause),
      });
    }
  }

  return { startedAt, status: "synced", accounts };
}

async function writeHoldings({
  store,
  accountId,
  holdings,
  asOf,
}: {
  store: FinancialsStore;
  accountId: string;
  holdings: SnapTradeHoldings;
  asOf: Date;
}): Promise<{ positions: number; holdingsInserted: number; skipped: number }> {
  const inputs: HoldingInput[] = [];
  let skipped = 0;

  for (const position of holdings.positions) {
    const symbol = positionSymbol(position);
    const ticker = symbol?.symbol?.trim();
    const quantity = position.units ?? position.fractional_units;

    // A position with no ticker cannot be keyed to a security, and one with no
    // quantity is not a position. Both are counted rather than swallowed, so a
    // provider change that starts dropping either shows up in the sync report
    // instead of as holdings quietly going missing.
    if (!ticker || quantity === null || quantity === undefined) {
      skipped += 1;
      continue;
    }

    const securityId = await store.upsertSecurity({
      symbol: ticker,
      name: symbol?.description?.trim() || null,
      securityType: securityTypeFor(position),
      extra: {
        // Kept even when the code mapped cleanly: `security_type` is this app's
        // vocabulary, and without the provider's own word for it a mapping
        // mistake is unrecoverable from the row.
        snaptrade_type_code: symbol?.type?.code ?? null,
        snaptrade_symbol_id: symbol?.id ?? null,
        raw_symbol: symbol?.raw_symbol ?? null,
      },
    });

    inputs.push({
      accountId,
      securityId,
      quantity: decimal(quantity)!,
      averageCostBasis: decimal(position.average_purchase_price),
      marketPrice: decimal(position.price),
      currency: position.currency?.code ?? symbol?.currency?.code ?? null,
      // An absent lot breakdown is absent, not empty: SnapTrade exposes lot
      // detail per brokerage and per security, so `[]` would claim the
      // brokerage said "no lots" when it said nothing at all.
      taxLots:
        Array.isArray(position.tax_lots) && position.tax_lots.length > 0 ? position.tax_lots : null,
      extra: {
        open_pnl: position.open_pnl ?? null,
        cash_equivalent: position.cash_equivalent ?? null,
      },
      asOf,
    });
  }

  return {
    positions: holdings.positions.length,
    holdingsInserted: await store.insertHoldings(inputs),
    skipped,
  };
}

/**
 * A `numeric` literal for a number SnapTrade sent as JSON.
 *
 * These arrive as JSON numbers, so they are already through a double by the time
 * this app sees them — `numeric` cannot recover precision the wire format never
 * carried. What it does buy is that nothing *further* is lost: no summing in
 * floating point, and no `0.1 + 0.2` in a portfolio total.
 */
function decimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  return String(value);
}

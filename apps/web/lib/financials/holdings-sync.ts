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
  securityTypeFor,
  type SnapTradeClient,
  type SnapTradePositions,
} from "./snaptrade";
import { createFinancialsStore, type FinancialsStore, type HoldingInput } from "./store";

export type AccountHoldingsResult = {
  snapTradeAccountId: string;
  /** The `financials_account` row the holdings were attached to. */
  accountId: string;
  status: "synced" | "failed";
  /** The reading time these holdings were stamped with. */
  asOf: string | null;
  /**
   * Where `asOf` came from. `run` means SnapTrade reported no usable
   * `data_freshness.as_of`, so these rows are keyed on this app's clock and a
   * retry will write them again — surfaced here because that is otherwise a
   * silent loss of idempotency.
   */
  asOfSource: "provider" | "run" | null;
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
   * Whether there was anything to sync — **not** whether it went well.
   * `synced` means the job had linked accounts and worked through them; every
   * one of them can still have failed, and `accounts[].status` is where that
   * lives. Named for the job's disposition because the alternative it
   * distinguishes is `not-linked`, which is a resting state rather than an
   * error: the Connection Portal flow ends at a human in a browser, and until
   * they have finished it there is nothing for the schedule to do.
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
      const holdings = await client.fetchPositions(snapTradeAccountId);
      const asOf = holdingsAsOf(holdings.asOf, now);

      const counts = await unitOfWork((query) =>
        writeHoldings({ store: createFinancialsStore(query), accountId, holdings, asOf: asOf.at }),
      );

      accounts.push({
        snapTradeAccountId,
        accountId,
        status: "synced",
        asOf: asOf.at.toISOString(),
        asOfSource: asOf.source,
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
        asOfSource: null,
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
  holdings: SnapTradePositions;
  asOf: Date;
}): Promise<{ positions: number; holdingsInserted: number; skipped: number }> {
  const inputs: HoldingInput[] = [];
  let skipped = 0;

  for (const position of holdings.positions) {
    const instrument = position.instrument;
    const ticker = instrument?.symbol?.trim();
    // Already a decimal string on the wire, so it reaches `numeric` without
    // passing through a double — a fractional share count is exact end to end.
    // Validated rather than trusted: `quantity` is `not null`, and a value the
    // column would reject must be skipped here, not discovered mid-insert where
    // it would fail the whole account's batch.
    const quantity = numericLiteral(position.units);

    // A position with no ticker cannot be keyed to a security, and one with no
    // usable quantity is not a position. Both are counted rather than swallowed,
    // so a provider change that starts dropping either shows up in the sync
    // report instead of as holdings quietly going missing.
    if (!ticker || quantity === null) {
      skipped += 1;
      continue;
    }

    const securityId = await store.upsertSecurity({
      symbol: ticker,
      name: instrument?.description?.trim() || null,
      securityType: securityTypeFor(position),
      extra: {
        // Kept even when the kind mapped cleanly: `security_type` is this app's
        // vocabulary, and without the provider's own word for it a mapping
        // mistake is unrecoverable from the row.
        snaptrade_kind: instrument?.kind ?? null,
        snaptrade_instrument_id: instrument?.id ?? null,
        raw_symbol: instrument?.raw_symbol ?? null,
        exchange: instrument?.exchange ?? null,
      },
    });

    inputs.push({
      accountId,
      securityId,
      quantity,
      averageCostBasis: numericLiteral(position.cost_basis),
      marketPrice: numericLiteral(position.price),
      currency: position.currency ?? instrument?.currency ?? null,
      // An absent lot breakdown is absent, not empty. SnapTrade gates lot detail
      // behind its paid plans, so on Personal this is null essentially always —
      // `[]` would claim the brokerage said "no lots" when it said nothing.
      taxLots:
        Array.isArray(position.tax_lots) && position.tax_lots.length > 0 ? position.tax_lots : null,
      extra: { cash_equivalent: position.cash_equivalent ?? null },
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
 * A `numeric` literal, or null for anything Postgres would reject.
 *
 * The v2 endpoints send these as decimal strings, so the honest job here is
 * validation rather than conversion — passing the string straight through is
 * what keeps the precision. Guarding on `Number` would be wrong in the other
 * direction: it is a *check*, not the value, because a string beyond double
 * range still round-trips into `numeric` perfectly well.
 */
function numericLiteral(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  // Deliberately strict: an optional sign, digits with at most one decimal
  // point, and an optional exponent. Anything else — empty, `NaN`, a currency
  // symbol, a thousands separator — is a value this column cannot hold, and
  // reaching the insert with it costs the whole account its sync.
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? trimmed : null;
}

import type {
  FetchLike,
  SnapTradeAccount,
  SnapTradeCredentials,
  SnapTradeHoldings,
  SnapTradePosition,
} from "@/lib/financials/snaptrade";

/**
 * Fixture SnapTrade responses, served over a stubbed `fetch`.
 *
 * Stubbed at `fetch` rather than at the client interface, for the reason the
 * SimpleFIN fixtures are: it keeps the real client in the path, so the tests
 * also cover the parts of it that are easy to get wrong — the request signature,
 * the query parameters, and tolerating a response with fields missing.
 */

export const TEST_CREDENTIALS: SnapTradeCredentials = {
  clientId: "BEN-OS-TEST",
  consumerKey: "test-consumer-key",
};

/** The authorization id the Connection Portal hands back on success. */
export const TEST_AUTHORIZATION_ID = "auth-fidelity-1";

export const FIDELITY_INDIVIDUAL = "st-acct-individual";
export const FIDELITY_ROTH = "st-acct-roth";

export function account(overrides: Partial<SnapTradeAccount> = {}): SnapTradeAccount {
  return {
    id: FIDELITY_INDIVIDUAL,
    brokerage_authorization: TEST_AUTHORIZATION_ID,
    name: "Individual",
    number: "X12345008",
    institution_name: "Fidelity",
    status: "open",
    account_category: "INVESTMENT",
    sync_status: {
      holdings: { initial_sync_completed: true, last_successful_sync: "2026-08-02T06:30:00Z" },
    },
    ...overrides,
  };
}

export function position(overrides: Partial<SnapTradePosition> = {}): SnapTradePosition {
  return {
    symbol: {
      symbol: {
        id: "sym-vti",
        symbol: "VTI",
        raw_symbol: "VTI",
        description: "Vanguard Total Stock Market ETF",
        currency: { code: "USD" },
        type: { code: "et", description: "Exchange Traded Fund" },
      },
    },
    units: 12.5,
    price: 291.44,
    open_pnl: 133.2,
    average_purchase_price: 280.78,
    currency: { code: "USD" },
    cash_equivalent: false,
    ...overrides,
  };
}

export function holdings(overrides: Partial<SnapTradeHoldings> = {}): SnapTradeHoldings {
  return { account: account(), positions: [position()], ...overrides };
}

export type StubbedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type StubbedFetch = FetchLike & {
  /** Every request the client made, in order. */
  calls: StubbedCall[];
};

/** A `fetch` answering each call with the next fixture, repeating the last one. */
export function stubJson(responses: unknown[]): StubbedFetch {
  const queue = [...responses];

  return stub((call) => {
    void call;

    const body = queue.length > 1 ? queue.shift() : queue[0];

    if (body === undefined) throw new Error("stubJson ran out of fixture responses.");

    return jsonResponse(body);
  });
}

/**
 * A `fetch` answering `/accounts/<id>/holdings` from a map.
 *
 * By account rather than in sequence, because the sync fetches one account at a
 * time and a sequence fixture would silently pass if it fetched them in the
 * wrong order — or twice.
 */
export function stubHoldingsByAccount(
  byAccount: Record<string, SnapTradeHoldings>,
  { accounts = [] as SnapTradeAccount[] } = {},
): StubbedFetch {
  return stub((call) => {
    const { pathname } = new URL(call.url);

    if (pathname.endsWith("/accounts")) return jsonResponse(accounts);

    const match = /\/accounts\/([^/]+)\/holdings$/.exec(pathname);

    if (match) {
      const id = decodeURIComponent(match[1]);
      const found = byAccount[id];

      if (found === undefined) return new Response('{"detail":"not found"}', { status: 404 });

      return jsonResponse(found);
    }

    throw new Error(`stubHoldingsByAccount has no fixture for ${pathname}`);
  });
}

/** A `fetch` answering with a bare status, for the error paths. */
export function stubStatus(status: number, body = ""): StubbedFetch {
  return stub(() => new Response(body, { status }));
}

function stub(respond: (call: StubbedCall) => Response): StubbedFetch {
  const calls: StubbedCall[] = [];

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: StubbedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: (init?.body as string | undefined) ?? null,
    };

    calls.push(call);

    return respond(call);
  }) as StubbedFetch;

  fetch.calls = calls;

  return fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

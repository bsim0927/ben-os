import type {
  FetchLike,
  SnapTradeAccount,
  SnapTradeCredentials,
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
    ...overrides,
  };
}

/**
 * The reading time `/positions/all` reports for its own response.
 *
 * Response-level in v2 (`data_freshness.as_of`), where the retired holdings
 * endpoint buried it in the account's `sync_status`.
 */
export const AS_OF = "2026-08-02T06:30:00Z";

/**
 * A position in the v2 shape: a flat `instrument`, and every number a decimal
 * string rather than a JSON number.
 */
export function position(overrides: Partial<SnapTradePosition> = {}): SnapTradePosition {
  return {
    instrument: {
      kind: "etf",
      id: "inst-vti",
      symbol: "VTI",
      raw_symbol: "VTI",
      description: "Vanguard Total Stock Market ETF",
      currency: "USD",
      exchange: "NYSE ARCA",
    },
    units: "12.5",
    price: "291.44",
    cost_basis: "280.78",
    currency: "USD",
    cash_equivalent: false,
    ...overrides,
  };
}

/** An `instrument` of a given kind, for the security-type mapping. */
export function instrumentOfKind(kind: string, symbol = "TEST") {
  return { kind, id: `inst-${symbol}`, symbol, raw_symbol: symbol, description: `${symbol} Inc.` };
}

/** The raw `/positions/all` response body, as SnapTrade sends it. */
export type PositionsResponse = {
  results: SnapTradePosition[];
  data_freshness?: { as_of?: string };
};

export function holdings(overrides: Partial<PositionsResponse> = {}): PositionsResponse {
  return { results: [position()], data_freshness: { as_of: AS_OF }, ...overrides };
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
  byAccount: Record<string, PositionsResponse>,
  { accounts = [] as SnapTradeAccount[] } = {},
): StubbedFetch {
  return stub((call) => {
    const { pathname } = new URL(call.url);

    if (pathname.endsWith("/accounts")) return jsonResponse(accounts);

    const match = /\/accounts\/([^/]+)\/positions\/all$/.exec(pathname);

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

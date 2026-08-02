import type {
  FetchLike,
  SimpleFinAccount,
  SimpleFinAccountSet,
  SimpleFinTransaction,
} from "@/lib/financials/simplefin";

/**
 * Fixture SimpleFIN responses, served over a stubbed `fetch`.
 *
 * Stubbing at `fetch` rather than at the client interface keeps the real client
 * in the path, so the tests also cover the things it does that are easy to get
 * wrong: lifting Basic Auth credentials out of the Access URL, the epoch-second
 * query parameters, and tolerating a response with fields missing.
 */

/** Shaped like a real one: credentials embedded, which `fetch` refuses to send. */
export const TEST_ACCESS_URL = "https://user-abc:pass-xyz@bridge.simplefin.test/simplefin";

export const CHASE_CONN = {
  conn_id: "conn-chase",
  name: "Chase",
  org_id: "org-chase",
  sfin_url: "https://bridge.simplefin.test/simplefin",
};

export const FIDELITY_CONN = {
  conn_id: "conn-fidelity",
  name: "Fidelity",
  org_id: "org-fidelity",
  sfin_url: "https://bridge.simplefin.test/simplefin",
};

export function account(overrides: Partial<SimpleFinAccount> = {}): SimpleFinAccount {
  return {
    id: "acct-chase-checking",
    name: "Chase Checking",
    conn_id: CHASE_CONN.conn_id,
    currency: "USD",
    balance: "1500.00",
    "balance-date": epoch("2026-08-01T12:00:00Z"),
    "available-balance": "1450.00",
    transactions: [],
    ...overrides,
  };
}

export function transaction(overrides: Partial<SimpleFinTransaction> = {}): SimpleFinTransaction {
  return {
    id: "txn-1",
    posted: epoch("2026-07-30T00:00:00Z"),
    amount: "-42.50",
    description: "COFFEE",
    ...overrides,
  };
}

export function accountSet(overrides: Partial<SimpleFinAccountSet> = {}): SimpleFinAccountSet {
  return { accounts: [], connections: [], errlist: [], ...overrides };
}

export function epoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export type StubbedFetch = FetchLike & {
  /** Every URL the client asked for, in order. */
  calls: string[];
};

/**
 * A `fetch` that answers each call with the next fixture, so a test can describe
 * two consecutive polls as two account sets.
 */
export function stubFetch(responses: SimpleFinAccountSet[]): StubbedFetch {
  const queue = [...responses];
  const calls: string[] = [];

  const fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));

    const body = queue.length > 1 ? queue.shift() : queue[0];

    if (body === undefined) {
      throw new Error("stubFetch ran out of fixture responses.");
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as StubbedFetch;

  fetch.calls = calls;

  return fetch;
}

/** A `fetch` answering with a bare status, for the error paths. */
export function stubStatus(status: number, body = ""): FetchLike {
  return (async () => new Response(body, { status })) as FetchLike;
}

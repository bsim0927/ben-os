/**
 * A client for the SimpleFIN protocol (v2), as implemented by SimpleFIN Bridge.
 *
 * The protocol is small enough to speak directly — see
 * `docs/research/simplefin-bridge-api.md`. Two things it does that a normal REST
 * client doesn't:
 *
 * - Credentials arrive embedded in the Access URL (`https://user:pass@host/path`)
 *   and have to be lifted out before fetching. See `splitAccessUrl`.
 * - There is no `/transactions` endpoint. `GET /accounts` is the only data call;
 *   transactions come nested inside each account.
 */

/** Bridge caps a single `/accounts` window at 90 days. */
export const SIMPLEFIN_MAX_WINDOW_DAYS = 90;

/**
 * How far back each scheduled poll reaches. Bridge recommends overlapping
 * consecutive windows by ~5 days, because an institution can post a transaction
 * days after it happened — a non-overlapping window would step straight over it.
 */
export const SIMPLEFIN_POLL_OVERLAP_DAYS = 5;

const MS_PER_DAY = 86_400_000;

export type SimpleFinTransaction = {
  id: string;
  posted: number;
  amount: string;
  description: string;
  transacted_at?: number;
  pending?: boolean;
  extra?: Record<string, unknown>;
};

export type SimpleFinAccount = {
  id: string;
  name: string;
  conn_id: string;
  currency: string;
  balance: string;
  "balance-date": number;
  "available-balance"?: string;
  transactions?: SimpleFinTransaction[];
  extra?: Record<string, unknown>;
};

export type SimpleFinConnection = {
  conn_id: string;
  name: string;
  org_id: string;
  sfin_url: string;
  org_url?: string;
};

/**
 * `code` is `prefix.subcode`, prefix ∈ `gen` | `con` | `act`. The spec tells
 * clients to treat an unrecognised subcode as its bare prefix, which is why
 * `errorScope` looks at the prefix only.
 */
export type SimpleFinError = {
  code?: string;
  msg: string;
  conn_id?: string;
  account_id?: string;
};

export type SimpleFinAccountSet = {
  accounts: SimpleFinAccount[];
  connections: SimpleFinConnection[];
  errlist: SimpleFinError[];
};

export type FetchLike = typeof globalThis.fetch;

/**
 * A span of time a poll covers. Named because three layers pass it around — the
 * client asks for it, the sync reports it, and the prune predicate is scoped to
 * it — and they must agree on which end is exclusive.
 */
export type PollWindow = {
  startDate: Date;
  /** Exclusive, matching the protocol's `end-date`. */
  endDate: Date;
};

export type AccountSetQuery = PollWindow & {
  pending?: boolean;
};

export type SimpleFinClient = {
  fetchAccountSet(query: AccountSetQuery): Promise<SimpleFinAccountSet>;
};

/**
 * Redeems a Setup Token for the long-lived Access URL.
 *
 * Callable exactly once per token: Bridge answers a second attempt with 403,
 * which the spec flags as a sign the token may have been compromised rather than
 * as a retryable error. The returned URL is a credential — it belongs in a
 * server-side secret, never in a database row (ADR 0002, deviation 2).
 */
export async function claimSetupToken(
  setupToken: string,
  { fetch = globalThis.fetch }: { fetch?: FetchLike } = {},
): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);

  const response = await fetch(claimUrl, {
    method: "POST",
    // Bridge's documented cURL sends this explicitly; a bodyless POST that omits
    // it has been seen to hang on some proxies.
    headers: { "Content-Length": "0" },
  });

  if (response.status === 403) {
    throw new Error(
      "SimpleFIN rejected the claim (403). A Setup Token can only be claimed once — " +
        "if this app never claimed it, treat the token as compromised and issue a new one.",
    );
  }

  if (!response.ok) {
    throw new Error(`SimpleFIN claim failed: ${response.status} ${response.statusText}`);
  }

  const accessUrl = (await response.text()).trim();

  // Parsing here rather than at first use, so a malformed claim response fails
  // at the one moment an operator is watching, not on a cron run days later.
  splitAccessUrl(accessUrl);

  return accessUrl;
}

/** A Setup Token is base64 over the one-time claim URL, nothing more. */
export function decodeSetupToken(setupToken: string): string {
  // Bridge's UI wraps the token across lines; whitespace is not part of it.
  const compact = setupToken.replace(/\s+/g, "");
  let decoded: string;

  try {
    decoded = atob(compact);
  } catch {
    throw new Error("Setup Token is not valid base64.");
  }

  let url: URL;

  try {
    url = new URL(decoded);
  } catch {
    throw new Error("Setup Token did not decode to a URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Setup Token decoded to a non-HTTP URL (${url.protocol}).`);
  }

  return decoded;
}

/**
 * Separates an Access URL into the base URL and its Basic Auth credentials.
 *
 * Not cosmetic: `fetch` refuses a URL carrying credentials outright
 * (undici throws "Request cannot be constructed from a URL that includes
 * credentials"), so the pair has to move into an Authorization header.
 */
export function splitAccessUrl(accessUrl: string): { baseUrl: string; authorization: string } {
  let url: URL;

  try {
    url = new URL(accessUrl);
  } catch {
    throw new Error("SIMPLEFIN_ACCESS_URL is not a valid URL.");
  }

  if (!url.username) {
    throw new Error(
      "SIMPLEFIN_ACCESS_URL carries no credentials — expected scheme://user:pass@host/path.",
    );
  }

  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;

  url.username = "";
  url.password = "";

  return {
    // Trailing slash removed so joining `/accounts` can't produce a double one.
    baseUrl: url.toString().replace(/\/+$/, ""),
    authorization: `Basic ${btoa(credentials)}`,
  };
}

export function createSimpleFinClient(
  accessUrl: string,
  { fetch = globalThis.fetch }: { fetch?: FetchLike } = {},
): SimpleFinClient {
  const { baseUrl, authorization } = splitAccessUrl(accessUrl);

  return {
    async fetchAccountSet(query) {
      const response = await fetch(accountsUrl(baseUrl, query), {
        headers: { Authorization: authorization, Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(
          `SimpleFIN /accounts failed: ${response.status} ${response.statusText}` +
            (response.status === 402
              ? " — the Bridge subscription is unpaid."
              : response.status === 403
                ? " — the Access URL has been revoked or disabled."
                : ""),
        );
      }

      return normaliseAccountSet(await response.json());
    },
  };
}

function accountsUrl(
  baseUrl: string,
  { startDate, endDate, pending = true }: AccountSetQuery,
): URL {
  const spanDays = (endDate.getTime() - startDate.getTime()) / MS_PER_DAY;

  if (spanDays < 0) {
    throw new Error("SimpleFIN window ends before it starts.");
  }

  // Enforced here rather than trusted from callers: Bridge silently truncates an
  // over-long window, which would look like an institution with no history.
  if (spanDays > SIMPLEFIN_MAX_WINDOW_DAYS) {
    throw new Error(
      `SimpleFIN windows are capped at ${SIMPLEFIN_MAX_WINDOW_DAYS} days; got ${Math.ceil(spanDays)}. ` +
        "Walk a longer history in successive windows instead.",
    );
  }

  const url = new URL(`${baseUrl}/accounts`);

  url.searchParams.set("version", "2");
  url.searchParams.set("start-date", String(toEpochSeconds(startDate)));
  url.searchParams.set("end-date", String(toEpochSeconds(endDate)));

  if (pending) {
    url.searchParams.set("pending", "1");
  }

  return url;
}

/**
 * The window a scheduled poll asks for: the last `days`, ending now.
 *
 * Deliberately not "since the last successful sync" — a transaction can post
 * days late, so anchoring to last-sync would skip anything that appeared behind
 * the cursor. Re-fetching the overlap is cheap because
 * `(account_id, provider_transaction_id)` dedupes it.
 */
export function pollWindow(now: Date, days: number = SIMPLEFIN_POLL_OVERLAP_DAYS): PollWindow {
  return {
    startDate: new Date(now.getTime() - days * MS_PER_DAY),
    endDate: now,
  };
}

export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function fromEpochSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

/**
 * `gen` errors are whole-poll; `con`/`act` name the connection or account they
 * spoil.
 *
 * The code wins over the ids when it is one the spec defines, because an error
 * may legitimately carry both: a `gen.*` quota warning that happens to mention a
 * `conn_id` is still poll-wide, and filing it under one bank would bury a
 * warning about the whole subscription inside that bank's ledger. Only when the
 * prefix is absent or unrecognised do the ids decide — the spec's own
 * instruction for unknown codes.
 */
export function errorScope(error: SimpleFinError): "general" | "connection" | "account" {
  switch (error.code?.split(".")[0]) {
    case "gen":
      return "general";
    case "con":
      return "connection";
    case "act":
      return "account";
  }

  if (error.conn_id) return "connection";
  if (error.account_id) return "account";

  return "general";
}

/**
 * Tolerates a server that omits `connections`/`errlist` entirely — v1 servers do,
 * and a missing array should read as "none", not crash the sync before the
 * accounts that did arrive are written.
 */
function normaliseAccountSet(payload: unknown): SimpleFinAccountSet {
  const body = (payload ?? {}) as Partial<SimpleFinAccountSet>;

  return {
    accounts: Array.isArray(body.accounts) ? body.accounts : [],
    connections: Array.isArray(body.connections) ? body.connections : [],
    errlist: Array.isArray(body.errlist) ? body.errlist : [],
  };
}

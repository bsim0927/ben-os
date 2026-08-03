/**
 * A client for the SnapTrade API (v1), in Personal mode.
 *
 * Spoken directly rather than through `snaptrade-typescript-sdk`, for the reason
 * `simplefin.ts` is: the surface this app needs is three endpoints, and a
 * fetch-shaped client is one a test can stub at the wire. The part that is *not*
 * small enough to guess is request signing, so `signaturePayload` below is a
 * deliberate byte-for-byte reimplementation of the official SDK's own signing
 * function, pinned by a test against the canonical example SnapTrade publishes.
 *
 * Two things it does that a normal REST client doesn't:
 *
 * - Every request carries a `Signature` header: an HMAC-SHA256, keyed by the
 *   consumer key, over a canonical JSON rendering of `{content, path, query}`.
 *   Nothing is retried or degraded on failure — a mis-signed request comes back
 *   as a bare 401 with no indication of which byte was wrong.
 * - It sends **no `userId`/`userSecret`**. That is what Personal mode is: the
 *   API key identifies the account holder, so there is no user to register and
 *   no secret to store. See docs/research/brokerage-holdings-provider.md §2.
 */

import { createHmac } from "node:crypto";

export const SNAPTRADE_PROVIDER = "snaptrade";

export const SNAPTRADE_BASE_URL = "https://api.snaptrade.com/api/v1";

/** The `broker` slug the Connection Portal opens straight into. */
export const SNAPTRADE_FIDELITY_SLUG = "FIDELITY";

export type FetchLike = typeof globalThis.fetch;

export type SnapTradeCredentials = {
  clientId: string;
  consumerKey: string;
};

/** ADR 0004's vocabulary for `financials_security.security_type`. */
export type SecurityType =
  "equity" | "etf" | "mutual_fund" | "fixed_income" | "cash" | "crypto" | "option" | "other";

export type SnapTradeSymbol = {
  id?: string;
  symbol?: string;
  raw_symbol?: string;
  description?: string | null;
  currency?: { code?: string } | null;
  type?: { code?: string; description?: string } | null;
};

export type SnapTradePosition = {
  /** Doubly nested in the protocol: `position.symbol.symbol` is the security. */
  symbol?: { symbol?: SnapTradeSymbol } | null;
  units?: number | null;
  fractional_units?: number | null;
  price?: number | null;
  open_pnl?: number | null;
  average_purchase_price?: number | null;
  currency?: { code?: string } | null;
  cash_equivalent?: boolean | null;
  tax_lots?: unknown[] | null;
};

export type SnapTradeAccount = {
  id: string;
  brokerage_authorization?: string;
  name?: string | null;
  number?: string;
  institution_name?: string;
  status?: string;
  account_category?: string;
  sync_status?: {
    holdings?: {
      initial_sync_completed?: boolean;
      last_successful_sync?: string | null;
      holdings_unavailable?: boolean;
    };
  };
};

export type SnapTradeHoldings = {
  account?: SnapTradeAccount;
  positions: SnapTradePosition[];
};

export type SnapTradeClient = {
  /** The hosted Connection Portal URL a human opens to complete the OAuth. */
  connectionPortalUrl(options?: ConnectionPortalOptions): Promise<string>;
  listAccounts(): Promise<SnapTradeAccount[]>;
  fetchHoldings(accountId: string): Promise<SnapTradeHoldings>;
};

export type ConnectionPortalOptions = {
  /** Skips the brokerage picker and opens straight into one institution. */
  broker?: string;
  /** Where SnapTrade sends the browser once the connection succeeds. */
  customRedirect?: string;
};

export type SignatureInput = {
  /** The request body, or `null` for a request that has none. */
  content: unknown;
  /** The full path including `/api/v1`, without the query string. */
  path: string;
  /** The query string exactly as sent, without the leading `?`. */
  query: string;
};

/**
 * The exact bytes a request's signature is computed over.
 *
 * `JSON.stringify`'s array-replacer form does the work: given every key that
 * appears anywhere in the value, sorted, it emits objects with their keys in
 * that order at every level. That is what "sort object keys alphabetically at
 * every level, remove unnecessary whitespace" means in practice, and it is what
 * the official SDK does — reimplemented rather than depended on so the wire
 * format stays visible and stubs stay possible.
 */
export function signaturePayload(input: SignatureInput): string {
  const keys: string[] = [];
  const seen = new Set<string>();

  JSON.stringify(input, (key, value) => {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }

    return value;
  });

  keys.sort();

  return JSON.stringify(input, keys);
}

/**
 * `encodeURI` on the key mirrors the official SDK exactly. It is a no-op for
 * every consumer key SnapTrade actually issues (they are base64-alphabet), and
 * it is kept anyway: a signing scheme that agrees with the server for the keys
 * you happen to hold is not the same as one that agrees with it.
 */
export function signRequest(input: SignatureInput, consumerKey: string): string {
  return createHmac("sha256", encodeURI(consumerKey))
    .update(signaturePayload(input), "utf8")
    .digest("base64");
}

export type CredentialsLookup =
  { configured: true; credentials: SnapTradeCredentials } | { configured: false; reason: string };

/**
 * The Personal API key pair, from the environment.
 *
 * Returned rather than thrown so a route can answer 503 ("nothing is configured
 * yet") distinctly from 502 ("SnapTrade said no") — the two need opposite
 * things from whoever is reading the response.
 */
export function readSnapTradeCredentials(): CredentialsLookup {
  const clientId = process.env.SNAPTRADE_CLIENT_ID?.trim();
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY?.trim();

  if (!clientId || !consumerKey) {
    return {
      configured: false,
      reason:
        "SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY are not both set on this deployment. " +
        "Create a Personal API key in the SnapTrade dashboard — every account gets one free, " +
        "with no approval step — then add both to the Vercel project's environment variables " +
        "and redeploy. Variables are read at build time, so a running deployment keeps the " +
        "ones it was built with.",
    };
  }

  return { configured: true, credentials: { clientId, consumerKey } };
}

export function createSnapTradeClient(
  credentials: SnapTradeCredentials,
  {
    fetch = globalThis.fetch,
    now = () => new Date(),
    baseUrl = SNAPTRADE_BASE_URL,
  }: { fetch?: FetchLike; now?: () => Date; baseUrl?: string } = {},
): SnapTradeClient {
  async function request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);

    url.searchParams.set("clientId", credentials.clientId);
    url.searchParams.set("timestamp", String(Math.floor(now().getTime() / 1000)));

    const serialised = body === undefined ? undefined : JSON.stringify(body);

    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        // Signed over the URL that is actually about to be sent, so the two can
        // never drift — the failure mode of signing a tidied-up copy is a 401
        // that names nothing.
        Signature: signRequest(
          {
            // An empty body signs as `null`, matching the SDK. The server agrees
            // with the SDK, so this is the definition rather than a nicety.
            content: serialised === undefined || serialised === "{}" ? null : body,
            path: url.pathname,
            query: url.search.slice(1),
          },
          credentials.consumerKey,
        ),
        ...(serialised === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: serialised,
    });

    if (!response.ok) {
      throw new Error(await failureMessage(response, method, path));
    }

    return response.json();
  }

  return {
    async connectionPortalUrl(options = {}) {
      const body = await request("POST", "/snapTrade/login", { ...options });
      const redirectUri = (body as { redirectURI?: unknown } | null)?.redirectURI;

      if (typeof redirectUri !== "string" || redirectUri === "") {
        // Reached when SnapTrade answers 200 with a session but no portal — a
        // shape a caller cannot act on, and one worth failing on here rather
        // than handing a human `undefined` to paste into a browser.
        throw new Error(
          "SnapTrade returned no redirect URI for the Connection Portal. " +
            "Check that the Personal API key is enabled in the SnapTrade dashboard.",
        );
      }

      return redirectUri;
    },

    async listAccounts() {
      const body = await request("GET", "/accounts");

      return Array.isArray(body) ? (body as SnapTradeAccount[]) : [];
    },

    async fetchHoldings(accountId) {
      const body = (await request(
        "GET",
        `/accounts/${encodeURIComponent(accountId)}/holdings`,
      )) as Partial<SnapTradeHoldings> | null;

      return {
        account: body?.account,
        // A missing array reads as "no positions", not as a broken response —
        // an account genuinely holding nothing is the same shape.
        positions: Array.isArray(body?.positions) ? body.positions : [],
      };
    },
  };
}

async function failureMessage(response: Response, method: string, path: string): Promise<string> {
  // SnapTrade puts the useful part in the body (`{"detail": "..."}`); the status
  // line alone says almost nothing about which of several mistakes was made.
  const detail = await response.text().catch(() => "");

  const hint =
    response.status === 401
      ? " — the request signature was rejected. Check SNAPTRADE_CLIENT_ID and " +
        "SNAPTRADE_CONSUMER_KEY: a wrong clientId or consumer key fails exactly like this."
      : response.status === 403
        ? " — the connection may have been revoked; re-run the Connection Portal flow."
        : response.status === 429
          ? " — rate limited. Personal keys allow 10 requests/minute per account."
          : "";

  return (
    `SnapTrade ${method} ${path} failed: ${response.status} ${response.statusText}${hint}` +
    (detail.trim() === "" ? "" : ` — ${detail.trim()}`)
  );
}

/**
 * When a set of holdings was last true, per the provider.
 *
 * Deliberately not the moment this app fetched them. `as_of` is half the key
 * that makes a re-run idempotent, so it has to be a property of the *reading*
 * rather than of the run: SnapTrade refreshes a Daily-plan connection once a
 * day, so two syncs between refreshes see the same `last_successful_sync`, and
 * the second inserts nothing. Stamping `now()` instead would write a fresh
 * snapshot of identical numbers on every retry.
 *
 * The fallback is the run's own instant, and it costs exactly that idempotency.
 * That is the right trade: a reading with a slightly-wrong timestamp is worth
 * more than no reading at all.
 */
export function holdingsAsOf(account: SnapTradeAccount | undefined, fallback: Date): Date {
  const reported = account?.sync_status?.holdings?.last_successful_sync;

  if (typeof reported !== "string") return fallback;

  const parsed = new Date(reported);

  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** The security a position is a position *in*, dug out of the double nesting. */
export function positionSymbol(position: SnapTradePosition): SnapTradeSymbol | undefined {
  return position.symbol?.symbol ?? undefined;
}

/**
 * SnapTrade's security-type codes, as far as they are known.
 *
 * SnapTrade publishes no exhaustive list of `type.code` values — the API
 * reference documents the field and gives `et` as an example, and that is all.
 * So this maps the codes that have been seen or are unambiguous, and everything
 * else lands as `other` with the raw code kept on the security's `extra`. An
 * unmapped security is then visible and one migration away from being fixed,
 * which a guessed mapping would not be.
 */
const SECURITY_TYPE_BY_CODE: Record<string, SecurityType> = {
  cs: "equity",
  ps: "equity",
  ad: "equity",
  et: "etf",
  mf: "mutual_fund",
  oef: "mutual_fund",
  cef: "mutual_fund",
  bnd: "fixed_income",
  crypto: "crypto",
  op: "option",
  cash: "cash",
};

export function securityTypeFor(position: SnapTradePosition): SecurityType {
  // `cash_equivalent` overrides the code: a money-market fund is reported with a
  // fund's type code, and calling it a mutual fund would put swept cash in the
  // same bucket as an actual investment position.
  if (position.cash_equivalent === true) return "cash";

  const code = positionSymbol(position)?.type?.code;

  return (code === undefined ? undefined : SECURITY_TYPE_BY_CODE[code.toLowerCase()]) ?? "other";
}

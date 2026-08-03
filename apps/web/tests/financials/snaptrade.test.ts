// @vitest-environment node
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createSnapTradeClient,
  holdingsAsOf,
  securityTypeFor,
  signaturePayload,
  signRequest,
  SNAPTRADE_BASE_URL,
} from "@/lib/financials/snaptrade";

import {
  AS_OF,
  holdings,
  instrumentOfKind,
  position,
  stubJson,
  stubStatus,
  TEST_CREDENTIALS,
} from "../support/snaptrade";

/**
 * The client, and the signing scheme underneath it.
 *
 * Signing gets the most attention here because it is the part with no forgiving
 * failure mode: a payload serialised one key out of order is rejected with a
 * bare 401 that says nothing about which byte was wrong.
 */

describe("signature payload", () => {
  it("matches the canonical form SnapTrade publishes for its own mock endpoint", () => {
    // Verbatim from SnapTrade's request-signing docs, which document the mock
    // signature endpoint by showing exactly what it signs. Pinning it here is
    // the only check available offline that the serialisation agrees with
    // theirs — key order, separators, and all.
    expect(
      signaturePayload({
        // Deliberately given out of order: the algorithm sorts, and a test that
        // hands them pre-sorted would pass without the sorting existing.
        content: { userSecret: "CHRIS.P.BACON", userId: "api@passiv.com" },
        path: "/api/v1/snapTrade/mockSignature",
        query: "clientId=PASSIVTEST&timestamp=1635790389",
      }),
    ).toBe(
      '{"content":{"userId":"api@passiv.com","userSecret":"CHRIS.P.BACON"},' +
        '"path":"/api/v1/snapTrade/mockSignature","query":"clientId=PASSIVTEST&timestamp=1635790389"}',
    );
  });

  it("represents a bodyless request as null rather than an empty object", () => {
    expect(signaturePayload({ content: null, path: "/api/v1/accounts", query: "clientId=x" })).toBe(
      '{"content":null,"path":"/api/v1/accounts","query":"clientId=x"}',
    );
  });

  it("sorts keys at every level, not just the top", () => {
    expect(
      signaturePayload({
        content: { zebra: { yak: 1, aardvark: 2 }, apple: 3 },
        path: "/api/v1/x",
        query: "",
      }),
    ).toBe('{"content":{"apple":3,"zebra":{"aardvark":2,"yak":1}},"path":"/api/v1/x","query":""}');
  });

  it("leaves the query string exactly as sent — order included", () => {
    // The docs are explicit that query parameters must not be sorted or
    // re-encoded before signing. Signing a tidied-up copy of a string the server
    // never saw is the subtle way to fail every request.
    const payload = signaturePayload({
      content: null,
      path: "/api/v1/accounts",
      query: "timestamp=2&clientId=1",
    });

    expect(payload).toContain('"query":"timestamp=2&clientId=1"');
  });
});

describe("signRequest", () => {
  it("is a base64 HMAC-SHA256 of the payload under the consumer key", () => {
    const payload = signaturePayload({ content: null, path: "/api/v1/accounts", query: "a=1" });

    expect(
      signRequest({ content: null, path: "/api/v1/accounts", query: "a=1" }, "secret-key"),
    ).toBe(createHmac("sha256", "secret-key").update(payload).digest("base64"));
  });
});

describe("createSnapTradeClient", () => {
  it("signs each call and identifies itself with clientId and a timestamp", async () => {
    const fetch = stubJson([[]]);
    const client = createSnapTradeClient(TEST_CREDENTIALS, {
      fetch,
      now: () => new Date("2026-08-02T12:00:00Z"),
    });

    await client.listAccounts();

    const url = new URL(fetch.calls[0].url);

    expect(url.origin + url.pathname).toBe(`${SNAPTRADE_BASE_URL}/accounts`);
    expect(url.searchParams.get("clientId")).toBe(TEST_CREDENTIALS.clientId);
    expect(url.searchParams.get("timestamp")).toBe(
      String(Math.floor(Date.parse("2026-08-02T12:00:00Z") / 1000)),
    );

    expect(fetch.calls[0].headers.Signature).toBe(
      signRequest(
        { content: null, path: "/api/v1/accounts", query: url.search.slice(1) },
        TEST_CREDENTIALS.consumerKey,
      ),
    );
  });

  it("omits userId and userSecret — Personal mode resolves the user from the key", async () => {
    const fetch = stubJson([[]]);

    await createSnapTradeClient(TEST_CREDENTIALS, { fetch }).listAccounts();

    const url = new URL(fetch.calls[0].url);

    expect(url.searchParams.has("userId")).toBe(false);
    expect(url.searchParams.has("userSecret")).toBe(false);
  });

  it("asks for a Connection Portal URL and hands back the redirect", async () => {
    const fetch = stubJson([
      { redirectURI: "https://app.snaptrade.test/portal?token=abc", sessionId: "s1" },
    ]);
    const client = createSnapTradeClient(TEST_CREDENTIALS, { fetch });

    const redirect = await client.connectionPortalUrl({ broker: "FIDELITY" });

    expect(redirect).toBe("https://app.snaptrade.test/portal?token=abc");
    expect(fetch.calls[0].method).toBe("POST");
    expect(new URL(fetch.calls[0].url).pathname).toBe("/api/v1/snapTrade/login");
    // The options travel as a JSON body, so they are what `content` signs over.
    expect(JSON.parse(fetch.calls[0].body as string)).toEqual({ broker: "FIDELITY" });
  });

  it("fails loudly when the portal answers without a redirect", async () => {
    const fetch = stubJson([{ sessionId: "s1" }]);

    await expect(
      createSnapTradeClient(TEST_CREDENTIALS, { fetch }).connectionPortalUrl(),
    ).rejects.toThrow(/no redirect/i);
  });

  it("reads positions from /positions/all — the endpoint that replaced /holdings", async () => {
    // SnapTrade answers the retired `/accounts/{id}/holdings` with 410 Gone for
    // accounts created after April 2026, which is how this was found.
    const fetch = stubJson([holdings()]);

    const result = await createSnapTradeClient(TEST_CREDENTIALS, { fetch }).fetchPositions(
      "st-acct-1",
    );

    expect(new URL(fetch.calls[0].url).pathname).toBe("/api/v1/accounts/st-acct-1/positions/all");
    expect(result.positions).toHaveLength(1);
    expect(result.asOf).toEqual(new Date(AS_OF));
  });

  it("takes as-of from the response's own data_freshness", async () => {
    const fetch = stubJson([holdings({ data_freshness: { as_of: "2026-08-01T05:00:00Z" } })]);

    const result = await createSnapTradeClient(TEST_CREDENTIALS, { fetch }).fetchPositions("a");

    expect(result.asOf).toEqual(new Date("2026-08-01T05:00:00Z"));
  });

  it("reports a missing or unparseable as-of as null rather than inventing one", async () => {
    for (const freshness of [undefined, { as_of: "not a date" }]) {
      const fetch = stubJson([holdings({ data_freshness: freshness })]);
      const result = await createSnapTradeClient(TEST_CREDENTIALS, { fetch }).fetchPositions("a");

      expect(result.asOf).toBeNull();
    }
  });

  it("tolerates a missing results array — an empty account is the same shape", async () => {
    const fetch = stubJson([{ data_freshness: { as_of: AS_OF } }]);

    const result = await createSnapTradeClient(TEST_CREDENTIALS, { fetch }).fetchPositions("a");

    expect(result.positions).toEqual([]);
  });

  it("percent-encodes an account id into the path it signs", async () => {
    const fetch = stubJson([holdings()]);

    await createSnapTradeClient(TEST_CREDENTIALS, { fetch }).fetchPositions("a b/c");

    const url = new URL(fetch.calls[0].url);

    expect(url.pathname).toBe("/api/v1/accounts/a%20b%2Fc/positions/all");
    expect(fetch.calls[0].headers.Signature).toBe(
      signRequest(
        { content: null, path: url.pathname, query: url.search.slice(1) },
        TEST_CREDENTIALS.consumerKey,
      ),
    );
  });

  it("names the likely cause when SnapTrade rejects the signature", async () => {
    const fetch = stubStatus(401, '{"detail":"Unable to verify signature"}');

    await expect(createSnapTradeClient(TEST_CREDENTIALS, { fetch }).listAccounts()).rejects.toThrow(
      /clientId or consumer key/i,
    );
  });

  it("surfaces the body of an error response, which carries SnapTrade's own detail", async () => {
    const fetch = stubStatus(500, '{"detail":"something broke"}');

    await expect(createSnapTradeClient(TEST_CREDENTIALS, { fetch }).listAccounts()).rejects.toThrow(
      /something broke/,
    );
  });
});

describe("holdingsAsOf", () => {
  const fallback = new Date("2026-08-02T09:00:00Z");

  it("uses the provider's reading time when there is one", () => {
    expect(holdingsAsOf(new Date(AS_OF), fallback)).toEqual({
      at: new Date(AS_OF),
      source: "provider",
    });
  });

  it("falls back to the run's own instant when the provider reports none", () => {
    // Losing the idempotency a provider timestamp buys is worth less than losing
    // the reading: without an `as_of` there is no row at all.
    expect(holdingsAsOf(null, fallback)).toEqual({ at: fallback, source: "run" });
    expect(holdingsAsOf(undefined, fallback)).toEqual({ at: fallback, source: "run" });
  });

  it("says which of the two happened, so a silent fallback cannot hide", () => {
    // If SnapTrade renamed `data_freshness.as_of`, `as_of` would quietly become
    // this app's clock, idempotency would stop working, and every hand-written
    // fixture here would still pass. Reporting it puts that in the cron body.
    expect(holdingsAsOf(new Date(AS_OF), fallback).source).toBe("provider");
    expect(holdingsAsOf(null, fallback).source).toBe("run");
  });
});

describe("securityTypeFor", () => {
  it("maps every instrument kind the protocol documents", () => {
    // `kind` is a documented discriminator, unlike the two-letter `type.code`
    // the retired endpoints carried — so this mapping is guaranteed by the API
    // rather than inferred by this app.
    const expected: Record<string, string> = {
      stock: "equity",
      adr: "equity",
      etf: "etf",
      mutualfund: "mutual_fund",
      cef: "mutual_fund",
      crypto: "crypto",
      option: "option",
      future: "other",
      cfd: "other",
      other: "other",
    };

    for (const [kind, securityType] of Object.entries(expected)) {
      expect(securityTypeFor(position({ instrument: instrumentOfKind(kind) }))).toBe(securityType);
    }
  });

  it("calls a cash-equivalent position cash, whatever its kind says", () => {
    // SnapTrade sets this on money-market funds also counted in cash balance;
    // filing swept cash as a mutual fund would bucket it with real investments.
    expect(
      securityTypeFor(
        position({ cash_equivalent: true, instrument: instrumentOfKind("mutualfund") }),
      ),
    ).toBe("cash");
  });

  it("falls back to 'other' for a kind added after this was written", () => {
    expect(securityTypeFor(position({ instrument: instrumentOfKind("warrant") }))).toBe("other");
    expect(securityTypeFor(position({ instrument: null }))).toBe("other");
  });
});

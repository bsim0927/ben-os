// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  claimSetupToken,
  createSimpleFinClient,
  decodeSetupToken,
  errorScope,
  pollWindow,
  SIMPLEFIN_MAX_WINDOW_DAYS,
  splitAccessUrl,
  toEpochSeconds,
  type FetchLike,
} from "@/lib/financials/simplefin";

import { account, accountSet, stubFetch, stubStatus, TEST_ACCESS_URL } from "../support/simplefin";

const CLAIM_URL = "https://bridge.simplefin.test/simplefin/claim/one-time-token";
const SETUP_TOKEN = btoa(CLAIM_URL);

describe("decodeSetupToken", () => {
  it("decodes the base64 blob to its claim URL", () => {
    expect(decodeSetupToken(SETUP_TOKEN)).toBe(CLAIM_URL);
  });

  it("ignores whitespace the Bridge UI wraps the token with", () => {
    expect(decodeSetupToken(`${SETUP_TOKEN.slice(0, 10)}\n  ${SETUP_TOKEN.slice(10)}`)).toBe(
      CLAIM_URL,
    );
  });

  it("rejects a token that is not base64", () => {
    expect(() => decodeSetupToken("!!!not base64!!!")).toThrow(/not valid base64/i);
  });

  it("rejects a token that decodes to something other than a URL", () => {
    expect(() => decodeSetupToken(btoa("just some text"))).toThrow(/did not decode to a URL/i);
  });
});

describe("claimSetupToken", () => {
  it("POSTs the decoded claim URL and returns the Access URL", async () => {
    const requests: { url: string; method?: string }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });

      return new Response(`${TEST_ACCESS_URL}\n`, { status: 200 });
    }) as FetchLike;

    await expect(claimSetupToken(SETUP_TOKEN, { fetch })).resolves.toBe(TEST_ACCESS_URL);
    expect(requests).toEqual([{ url: CLAIM_URL, method: "POST" }]);
  });

  it("explains a 403 as the one-time claim already having been spent", async () => {
    await expect(claimSetupToken(SETUP_TOKEN, { fetch: stubStatus(403) })).rejects.toThrow(
      /only be claimed once/i,
    );
  });

  it("rejects an Access URL that carries no credentials, at claim time", async () => {
    const fetch = stubStatus(200, "https://bridge.simplefin.test/simplefin");

    await expect(claimSetupToken(SETUP_TOKEN, { fetch })).rejects.toThrow(/no credentials/i);
  });
});

describe("splitAccessUrl", () => {
  it("lifts the embedded credentials into a Basic Auth header", () => {
    expect(splitAccessUrl(TEST_ACCESS_URL)).toEqual({
      baseUrl: "https://bridge.simplefin.test/simplefin",
      authorization: `Basic ${btoa("user-abc:pass-xyz")}`,
    });
  });

  it("decodes percent-encoded credentials before encoding them", () => {
    const { authorization } = splitAccessUrl("https://user:p%40ss%3Aword@host.test/x");

    expect(authorization).toBe(`Basic ${btoa("user:p@ss:word")}`);
  });
});

describe("createSimpleFinClient", () => {
  it("never puts credentials in the request URL — fetch refuses to send them", async () => {
    const fetch = stubFetch([accountSet()]);
    const client = createSimpleFinClient(TEST_ACCESS_URL, { fetch });

    await client.fetchAccountSet({
      startDate: new Date("2026-07-27T00:00:00Z"),
      endDate: new Date("2026-08-01T00:00:00Z"),
    });

    expect(fetch.calls[0]).not.toContain("pass-xyz");
    expect(fetch.calls[0]).toContain("https://bridge.simplefin.test/simplefin/accounts");
  });

  it("asks for v2, the window in epoch seconds, and pending transactions", async () => {
    const fetch = stubFetch([accountSet()]);
    const client = createSimpleFinClient(TEST_ACCESS_URL, { fetch });
    const startDate = new Date("2026-07-27T00:00:00Z");
    const endDate = new Date("2026-08-01T00:00:00Z");

    await client.fetchAccountSet({ startDate, endDate });

    const url = new URL(fetch.calls[0]);

    expect(url.searchParams.get("version")).toBe("2");
    expect(url.searchParams.get("start-date")).toBe(String(toEpochSeconds(startDate)));
    expect(url.searchParams.get("end-date")).toBe(String(toEpochSeconds(endDate)));
    expect(url.searchParams.get("pending")).toBe("1");
  });

  it("refuses a window wider than Bridge's 90-day cap rather than let it be truncated", async () => {
    const client = createSimpleFinClient(TEST_ACCESS_URL, { fetch: stubFetch([accountSet()]) });

    await expect(
      client.fetchAccountSet({
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-08-01T00:00:00Z"),
      }),
    ).rejects.toThrow(new RegExp(`capped at ${SIMPLEFIN_MAX_WINDOW_DAYS} days`));
  });

  it("treats missing connections/errlist as empty rather than failing the poll", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ accounts: [account()] }), { status: 200 })) as FetchLike;

    const result = await createSimpleFinClient(TEST_ACCESS_URL, { fetch }).fetchAccountSet({
      startDate: new Date("2026-07-27T00:00:00Z"),
      endDate: new Date("2026-08-01T00:00:00Z"),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.connections).toEqual([]);
    expect(result.errlist).toEqual([]);
  });

  it("names the cause when the subscription is unpaid or the URL revoked", async () => {
    const unpaid = createSimpleFinClient(TEST_ACCESS_URL, { fetch: stubStatus(402) });
    const revoked = createSimpleFinClient(TEST_ACCESS_URL, { fetch: stubStatus(403) });
    const window = {
      startDate: new Date("2026-07-27T00:00:00Z"),
      endDate: new Date("2026-08-01T00:00:00Z"),
    };

    await expect(unpaid.fetchAccountSet(window)).rejects.toThrow(/subscription is unpaid/i);
    await expect(revoked.fetchAccountSet(window)).rejects.toThrow(/revoked or disabled/i);
  });
});

describe("pollWindow", () => {
  it("reaches back over the overlap Bridge recommends, so a late post is not stepped over", () => {
    const now = new Date("2026-08-01T09:17:00Z");

    expect(pollWindow(now)).toEqual({
      startDate: new Date("2026-07-27T09:17:00Z"),
      endDate: now,
    });
  });
});

describe("errorScope", () => {
  it("reads the prefix of the error code", () => {
    expect(errorScope({ code: "con.disconnected", msg: "x" })).toBe("connection");
    expect(errorScope({ code: "act.needs-attention", msg: "x" })).toBe("account");
    expect(errorScope({ code: "gen.quota", msg: "x" })).toBe("general");
  });

  it("falls back to the ids when a code is absent or unrecognised", () => {
    expect(errorScope({ msg: "x", conn_id: "c" })).toBe("connection");
    expect(errorScope({ msg: "x", account_id: "a" })).toBe("account");
    expect(errorScope({ msg: "x" })).toBe("general");
  });
});

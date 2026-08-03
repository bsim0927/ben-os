// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withAuthorizedSession, financialsPool, syncSnapTradeHoldings, createSnapTradeClient } =
  vi.hoisted(() => ({
    withAuthorizedSession: vi.fn(),
    financialsPool: vi.fn(),
    syncSnapTradeHoldings: vi.fn(),
    createSnapTradeClient: vi.fn(),
  }));

vi.mock("@/lib/financials/db", () => ({ withAuthorizedSession, financialsPool }));
vi.mock("@/lib/financials/holdings-sync", () => ({ syncSnapTradeHoldings }));
vi.mock("@/lib/financials/snaptrade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/financials/snaptrade")>()),
  createSnapTradeClient,
}));

import { GET } from "@/app/api/cron/financials-holdings/route";

function cronRequest(authorization = "Bearer test-secret"): Request {
  return new Request("https://ben-os.test/api/cron/financials-holdings", {
    headers: { authorization },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "test-secret";
  process.env.SNAPTRADE_CLIENT_ID = "BEN-OS-TEST";
  process.env.SNAPTRADE_CONSUMER_KEY = "test-consumer-key";
  withAuthorizedSession.mockImplementation((_pool, fn) => fn(vi.fn()));
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.SNAPTRADE_CLIENT_ID;
  delete process.env.SNAPTRADE_CONSUMER_KEY;
});

describe("GET /api/cron/financials-holdings", () => {
  it("turns away a request without the cron secret, before touching anything", async () => {
    const response = await GET(cronRequest("Bearer wrong"));

    expect(response.status).toBe(401);
    expect(financialsPool).not.toHaveBeenCalled();
    expect(syncSnapTradeHoldings).not.toHaveBeenCalled();
  });

  it("runs the sync and returns its summary", async () => {
    const summary = { startedAt: "2026-08-02T13:41:00.000Z", status: "synced", accounts: [] };
    syncSnapTradeHoldings.mockResolvedValue(summary);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(summary);
  });

  it("answers 200 when one account failed — the job itself still ran", async () => {
    syncSnapTradeHoldings.mockResolvedValue({
      status: "synced",
      accounts: [{ snapTradeAccountId: "st-1", status: "failed" }],
    });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
  });

  it("answers 200 for a database nobody has linked yet — that is a resting state", async () => {
    // Not an error: the Connection Portal flow ends at a human in a browser, and
    // until they have been through it there is genuinely nothing to fetch. A
    // non-2xx here would read as a broken job every day until then.
    syncSnapTradeHoldings.mockResolvedValue({ status: "not-linked", accounts: [] });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "not-linked" });
  });

  it("reports 503 when no Personal API key is configured", async () => {
    delete process.env.SNAPTRADE_CONSUMER_KEY;

    const response = await GET(cronRequest());

    expect(response.status).toBe(503);
    expect(syncSnapTradeHoldings).not.toHaveBeenCalled();
  });

  it("reports 502 when the job itself could not run", async () => {
    syncSnapTradeHoldings.mockRejectedValue(new Error("SnapTrade GET /accounts failed: 429"));

    const response = await GET(cronRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: /429/ as unknown as string });
  });
});

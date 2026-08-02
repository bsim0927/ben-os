// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withAuthorizedSession, financialsPool, syncSimpleFin, simpleFinClientFor } = vi.hoisted(
  () => ({
    withAuthorizedSession: vi.fn(),
    financialsPool: vi.fn(),
    syncSimpleFin: vi.fn(),
    simpleFinClientFor: vi.fn(),
  }),
);

vi.mock("@/lib/financials/db", () => ({ withAuthorizedSession, financialsPool }));
vi.mock("@/lib/financials/sync", () => ({ syncSimpleFin, simpleFinClientFor }));

import { GET } from "@/app/api/cron/financials-sync/route";

function cronRequest(authorization = "Bearer test-secret"): Request {
  return new Request("https://ben-os.test/api/cron/financials-sync", {
    headers: { authorization },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "test-secret";
  process.env.SIMPLEFIN_ACCESS_URL = "https://u:p@bridge.simplefin.test/simplefin";
  // Hand the route's callback a unit-of-work it can call without a database.
  withAuthorizedSession.mockImplementation((_pool, fn) => fn(vi.fn()));
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.SIMPLEFIN_ACCESS_URL;
});

describe("GET /api/cron/financials-sync", () => {
  it("turns away a request without the cron secret, before touching anything", async () => {
    const response = await GET(cronRequest("Bearer wrong"));

    expect(response.status).toBe(401);
    expect(financialsPool).not.toHaveBeenCalled();
    expect(syncSimpleFin).not.toHaveBeenCalled();
  });

  it("runs the sync and returns its summary", async () => {
    const summary = { startedAt: "2026-08-01T09:17:00.000Z", connections: [] };
    syncSimpleFin.mockResolvedValue(summary);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(summary);
  });

  it("answers 200 when a single connection failed — the poll itself still ran", async () => {
    // A broken institution is data for the dashboard, not an HTTP failure. A
    // non-2xx here would make Vercel retry the whole poll and burn the daily
    // request budget without fixing the bank.
    syncSimpleFin.mockResolvedValue({
      connections: [{ providerConnId: "conn-fidelity", status: "failed" }],
    });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
  });

  it("reports 503 when no Access URL has been claimed yet", async () => {
    delete process.env.SIMPLEFIN_ACCESS_URL;

    const response = await GET(cronRequest());

    expect(response.status).toBe(503);
    expect(syncSimpleFin).not.toHaveBeenCalled();
  });

  it("reports 502 when the poll itself could not run", async () => {
    syncSimpleFin.mockRejectedValue(new Error("SimpleFIN /accounts failed: 402"));

    const response = await GET(cronRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: /402/ as unknown as string });
  });
});

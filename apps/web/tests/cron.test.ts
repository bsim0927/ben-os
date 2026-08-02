// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "@/lib/cron";

function requestWith(authorization?: string): Request {
  return new Request("https://ben-os.test/api/cron/financials-sync", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("isAuthorizedCronRequest", () => {
  it("accepts the configured secret as a bearer token", () => {
    process.env.CRON_SECRET = "s3cret-value";

    expect(isAuthorizedCronRequest(requestWith("Bearer s3cret-value"))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    process.env.CRON_SECRET = "s3cret-value";

    expect(isAuthorizedCronRequest(requestWith("Bearer wrong-value"))).toBe(false);
  });

  it("rejects a secret of a different length without throwing", () => {
    // timingSafeEqual throws on mismatched lengths; the length check in front of
    // it is what keeps this a `false` rather than a 500.
    process.env.CRON_SECRET = "s3cret-value";

    expect(isAuthorizedCronRequest(requestWith("Bearer short"))).toBe(false);
  });

  it("rejects a missing or non-bearer Authorization header", () => {
    process.env.CRON_SECRET = "s3cret-value";

    expect(isAuthorizedCronRequest(requestWith())).toBe(false);
    expect(isAuthorizedCronRequest(requestWith("Basic s3cret-value"))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith("s3cret-value"))).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    // The dangerous misconfiguration: an unset secret must not read as "open".
    expect(isAuthorizedCronRequest(requestWith("Bearer anything"))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith())).toBe(false);
  });
});

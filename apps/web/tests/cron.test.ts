// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authorizeCronRequest } from "@/lib/cron";

function requestWith(authorization?: string): Request {
  return new Request("https://ben-os.test/api/cron/financials-sync", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("authorizeCronRequest", () => {
  it("accepts the configured secret as a bearer token", () => {
    process.env.CRON_SECRET = "s3cret-value";

    expect(authorizeCronRequest(requestWith("Bearer s3cret-value"))).toEqual({ authorized: true });
  });

  it("tolerates whitespace a dashboard paste left on either value", () => {
    // The failure this prevents is invisible: a trailing newline on the stored
    // secret makes the lengths differ, and the request looks simply wrong.
    process.env.CRON_SECRET = "s3cret-value\n";

    expect(authorizeCronRequest(requestWith("Bearer s3cret-value "))).toEqual({ authorized: true });
  });

  it("rejects a wrong secret, and says that is what happened", () => {
    process.env.CRON_SECRET = "s3cret-value";

    const result = authorizeCronRequest(requestWith("Bearer wrong-value"));

    expect(result.authorized).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("does not match") });
  });

  it("rejects a secret of a different length without throwing", () => {
    // timingSafeEqual throws on mismatched lengths; the length check in front of
    // it is what keeps this a rejection rather than a 500.
    process.env.CRON_SECRET = "s3cret-value";

    expect(authorizeCronRequest(requestWith("Bearer short")).authorized).toBe(false);
  });

  it("distinguishes a missing header from a malformed one", () => {
    process.env.CRON_SECRET = "s3cret-value";

    expect(authorizeCronRequest(requestWith())).toMatchObject({
      reason: expect.stringContaining("No Authorization header"),
    });
    expect(authorizeCronRequest(requestWith("Basic s3cret-value"))).toMatchObject({
      reason: expect.stringContaining("Bearer"),
    });
  });

  it("fails closed when no secret is configured, and names that as the cause", () => {
    // The dangerous misconfiguration: an unset secret must not read as "open".
    // Naming it costs nothing — the endpoint is shut in this branch either way,
    // and the operator is the only one who can act on knowing.
    const result = authorizeCronRequest(requestWith("Bearer anything"));

    expect(result.authorized).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("CRON_SECRET is not set") });
  });

  it("never puts the secret in the reason it gives back", () => {
    process.env.CRON_SECRET = "super-secret-do-not-leak";

    for (const request of [requestWith(), requestWith("Bearer nope"), requestWith("Basic x")]) {
      const result = authorizeCronRequest(request);

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).not.toContain("super-secret-do-not-leak");
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import { ALLOWED_EMAIL, isAuthorizedEmail } from "@/lib/auth";

describe("isAuthorizedEmail", () => {
  it("accepts the one allowed account", () => {
    expect(isAuthorizedEmail(ALLOWED_EMAIL)).toBe(true);
  });

  it("accepts it regardless of casing or surrounding whitespace", () => {
    expect(isAuthorizedEmail(` ${ALLOWED_EMAIL.toUpperCase()} `)).toBe(true);
  });

  it("rejects a different — but perfectly valid — Google account", () => {
    expect(isAuthorizedEmail("someone.else@gmail.com")).toBe(false);
  });

  it("rejects a lookalike that merely contains the allowed address", () => {
    expect(isAuthorizedEmail(`${ALLOWED_EMAIL}.attacker.com`)).toBe(false);
    expect(isAuthorizedEmail(`x${ALLOWED_EMAIL}`)).toBe(false);
  });

  it("rejects a missing email claim", () => {
    expect(isAuthorizedEmail(null)).toBe(false);
    expect(isAuthorizedEmail(undefined)).toBe(false);
    expect(isAuthorizedEmail("")).toBe(false);
  });
});

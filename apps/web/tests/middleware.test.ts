// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALLOWED_EMAIL } from "@/lib/auth";
import { updateSession } from "@/lib/supabase/middleware";

import { fakeUser } from "./support/user";

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock("@supabase/ssr", () => ({ createServerClient }));

/** Stand in for whoever the session cookies resolve to on this request. */
function signedInAs(email: string | null) {
  const user = email === null ? null : fakeUser(email);

  createServerClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  });
}

function request(path: string) {
  return new NextRequest(new URL(path, "https://ben-os.test"));
}

beforeEach(() => {
  createServerClient.mockReset();
});

describe("updateSession", () => {
  it("lets the authorized account through to a protected page", async () => {
    signedInAs(ALLOWED_EMAIL);

    const response = await updateSession(request("/"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("sends an unauthenticated request to the login page", async () => {
    signedInAs(null);

    const response = await updateSession(request("/"));

    expect(response.headers.get("location")).toBe("https://ben-os.test/login");
  });

  it("denies a valid-but-wrong Google account, and says why", async () => {
    signedInAs("someone.else@gmail.com");

    const response = await updateSession(request("/"));

    expect(response.headers.get("location")).toBe("https://ben-os.test/login?error=unauthorized");
  });

  it("denies the wrong account on module pages too, not just the root", async () => {
    signedInAs("someone.else@gmail.com");

    const response = await updateSession(request("/financials/fidelity/holdings"));

    expect(response.headers.get("location")).toBe("https://ben-os.test/login?error=unauthorized");
  });

  it("leaves the login page reachable while signed out", async () => {
    signedInAs(null);

    const response = await updateSession(request("/login"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("leaves the login page reachable to a wrong account, so it can sign out", async () => {
    signedInAs("someone.else@gmail.com");

    const response = await updateSession(request("/login?error=unauthorized"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("bounces the authorized account off the login page", async () => {
    signedInAs(ALLOWED_EMAIL);

    const response = await updateSession(request("/login"));

    expect(response.headers.get("location")).toBe("https://ben-os.test/");
  });

  it("lets the OAuth callback run before anyone is known", async () => {
    signedInAs(null);

    const response = await updateSession(request("/auth/callback?code=abc"));

    expect(response.headers.get("location")).toBeNull();
  });
});

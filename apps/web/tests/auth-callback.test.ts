// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALLOWED_EMAIL } from "@/lib/auth";

import { fakeUser } from "./support/user";

import { GET } from "@/app/auth/callback/route";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

const signOut = vi.fn();
const exchangeCodeForSession = vi.fn();

/** The account Google hands back once the code is exchanged. */
function callbackReturns(email: string | null, { exchangeFails = false } = {}) {
  exchangeCodeForSession.mockResolvedValue({
    error: exchangeFails ? { message: "bad code" } : null,
  });

  createClient.mockResolvedValue({
    auth: {
      exchangeCodeForSession,
      signOut,
      getUser: async () => ({
        data: { user: email === null ? null : fakeUser(email) },
        error: null,
      }),
    },
  });
}

function callbackRequest(query: string) {
  return new Request(`https://ben-os.test/auth/callback${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("the OAuth callback", () => {
  it("lands the authorized account on the console", async () => {
    callbackReturns(ALLOWED_EMAIL);

    const response = await GET(callbackRequest("?code=good"));

    expect(response.headers.get("location")).toBe("https://ben-os.test/");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out a valid-but-wrong Google account rather than leaving it a session", async () => {
    callbackReturns("someone.else@gmail.com");

    const response = await GET(callbackRequest("?code=good"));

    expect(signOut).toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://ben-os.test/login?error=unauthorized");
  });

  it("rejects a callback with no code, without exchanging anything", async () => {
    callbackReturns(ALLOWED_EMAIL);

    const response = await GET(callbackRequest(""));

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://ben-os.test/login?error=signin_failed");
  });

  it("reports a failed code exchange instead of pretending it worked", async () => {
    callbackReturns(ALLOWED_EMAIL, { exchangeFails: true });

    const response = await GET(callbackRequest("?code=stale"));

    expect(response.headers.get("location")).toBe("https://ben-os.test/login?error=signin_failed");
  });

  it("redirects to the configured site URL when one is set", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://ben-os.example.com/";
    callbackReturns(ALLOWED_EMAIL);

    const response = await GET(callbackRequest("?code=good"));

    expect(response.headers.get("location")).toBe("https://ben-os.example.com/");
  });

  it("ignores x-forwarded-host, which any caller can set", async () => {
    callbackReturns(ALLOWED_EMAIL);

    const request = new Request("https://ben-os.test/auth/callback?code=good", {
      headers: { "x-forwarded-host": "attacker.example" },
    });
    const response = await GET(request);

    expect(response.headers.get("location")).toBe("https://ben-os.test/");
  });
});

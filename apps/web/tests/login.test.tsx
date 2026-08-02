import type { User } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALLOWED_EMAIL } from "@/lib/auth";

import LoginPage from "@/app/login/page";

const { createClient, createBrowserClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
  createBrowserClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/client", () => ({ createClient: createBrowserClient }));

function signedInAs(email: string | null) {
  const user = email === null ? null : ({ id: "user-1", email } as User);

  createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  });
}

async function renderLogin(error?: string) {
  render(await LoginPage({ searchParams: Promise.resolve(error ? { error } : {}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the login page", () => {
  it("offers Google sign-in to a signed-out visitor", async () => {
    signedInAs(null);

    await renderLogin();

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("explains the rejection when a wrong account was bounced back", async () => {
    signedInAs(null);

    await renderLogin("unauthorized");

    expect(screen.getByRole("alert")).toHaveTextContent(/not authorized/i);
  });

  it("tells a signed-in wrong account it is not authorized, and offers a way out", async () => {
    signedInAs("someone.else@gmail.com");

    await renderLogin("unauthorized");

    expect(screen.getByRole("alert")).toHaveTextContent(/not authorized/i);
    expect(screen.getByText("someone.else@gmail.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();

    // Offering "continue with Google" again would just loop them back here.
    expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();
  });

  it("never leaks the allowed address to an unauthorized visitor", async () => {
    signedInAs("someone.else@gmail.com");

    await renderLogin("unauthorized");

    expect(document.body.textContent).not.toContain(ALLOWED_EMAIL);
  });
});

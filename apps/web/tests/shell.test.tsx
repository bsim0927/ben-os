import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALLOWED_EMAIL } from "@/lib/auth";

import { fakeUser } from "./support/user";

import ShellLayout from "@/app/(modules)/layout";

const { createClient, redirect, usePathname } = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn((url: string) => {
    // The real `redirect()` throws to halt rendering; mirror that, or the test
    // would go on to render a shell the user was supposed to never see.
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: vi.fn(() => "/"),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("next/navigation", () => ({ redirect, usePathname }));

function signedInAs(email: string | null, metadata: Record<string, unknown> = {}) {
  const user = email === null ? null : fakeUser(email, metadata);

  createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  });
}

async function renderShell() {
  render(await ShellLayout({ children: <p>module content</p> }));
}

beforeEach(() => {
  vi.clearAllMocks();
  usePathname.mockReturnValue("/");
});

describe("the shell, for the authorized account", () => {
  beforeEach(() => {
    signedInAs(ALLOWED_EMAIL, { full_name: "Ben Simmons" });
  });

  it("renders the module content it was given", async () => {
    await renderShell();

    expect(screen.getByText("module content")).toBeInTheDocument();
  });

  it("lists every module in the sidebar, built or not", async () => {
    await renderShell();

    const nav = within(screen.getByRole("navigation"));

    for (const label of ["Financials", "Email", "Calendar", "Notes"]) {
      expect(nav.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows unbuilt modules as dimmed and unclickable rather than hiding them", async () => {
    await renderShell();

    const nav = within(screen.getByRole("navigation"));

    // Financials is built and so is the one link; the rest stay visible, tagged
    // and inert, because the sidebar shows what the app is for.
    expect(nav.getAllByRole("link")).toHaveLength(1);
    expect(nav.getAllByText("Soon")).toHaveLength(3);

    for (const label of ["Email", "Calendar", "Notes"]) {
      expect(nav.getByRole("listitem", { name: label })).toHaveAttribute("data-status", "soon");
    }
  });

  it("makes a built module reachable from the sidebar", async () => {
    await renderShell();

    const nav = within(screen.getByRole("navigation"));

    expect(nav.getByRole("listitem", { name: "Financials" })).toHaveAttribute(
      "data-status",
      "live",
    );
    expect(nav.getByRole("link", { name: /Financials/ })).toHaveAttribute("href", "/financials");
  });

  it("shows the crumb row for the page being viewed", async () => {
    await renderShell();

    const crumb = screen.getByTestId("crumb");

    expect(crumb).toHaveTextContent("Console");
    expect(crumb).toHaveTextContent("Overview");
  });

  it("derives the crumb from the module registry on a module page", async () => {
    usePathname.mockReturnValue("/financials/fidelity/holdings");

    await renderShell();

    const crumb = screen.getByTestId("crumb");

    expect(crumb).toHaveTextContent("Financials");
    expect(crumb).toHaveTextContent("Holdings");
  });

  it("marks the active module in the sidebar", async () => {
    usePathname.mockReturnValue("/financials");

    await renderShell();

    const nav = within(screen.getByRole("navigation"));

    expect(nav.getByRole("listitem", { name: "Financials" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("listitem", { name: "Email" })).not.toHaveAttribute("aria-current");
  });

  it("names the signed-in account in the sidebar footer", async () => {
    await renderShell();

    const account = within(screen.getByTestId("user-chip"));

    expect(account.getByText("Ben Simmons")).toBeInTheDocument();
    expect(account.getByTestId("avatar")).toHaveTextContent("B");
  });

  it("falls back to the email when the account has no name", async () => {
    signedInAs(ALLOWED_EMAIL);

    await renderShell();

    const account = within(screen.getByTestId("user-chip"));

    expect(account.getByText(ALLOWED_EMAIL)).toBeInTheDocument();
  });
});

describe("the shell, for everyone else", () => {
  it("is not rendered at all for an unauthenticated request", async () => {
    signedInAs(null);

    await expect(renderShell()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(screen.queryByText("module content")).not.toBeInTheDocument();
  });

  it("is not rendered for a valid-but-wrong Google account", async () => {
    signedInAs("someone.else@gmail.com");

    await expect(renderShell()).rejects.toThrow("NEXT_REDIRECT:/login?error=unauthorized");
    expect(screen.queryByText("module content")).not.toBeInTheDocument();
  });

  it("is not rendered when the session lookup itself fails", async () => {
    createClient.mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: null }, error: { message: "network" } }),
      },
    });

    await expect(renderShell()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});

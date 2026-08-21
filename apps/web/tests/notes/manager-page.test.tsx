import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient: createServerClient }));

import NotesManagerPage from "@/app/(modules)/notes/page";

/**
 * The Notes manager rendered from seeded `notes_notepad` + `notes_note` rows.
 *
 * Asserted on the assembled page rather than only on `manager-view`, because the
 * claims worth pinning here span the two reads and the render together: the rail
 * counts notes it queried separately, the detail pane opens on the inbox and
 * swaps on a rail click, and the ADR-0010 rendering rules (checkbox, due chip,
 * agent chip, `show original`) have to survive the trip through the page's view
 * models into the DOM.
 *
 * The clock is fixed so the `new` badge and the due window are deterministic; the
 * fixture is dated relative to it.
 */

const NOW = new Date("2026-08-15T12:00:00Z");

type NotepadSeed = {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  created_at: string;
};

type NoteSeed = {
  id: string;
  notepad_id: string | null;
  raw_text: string;
  body: string;
  structure: Record<string, unknown>;
  channel: string;
  captured_at: string;
  triaged_at: string | null;
  triage: Record<string, unknown>;
  created_at: string;
};

const notepads: NotepadSeed[] = [
  {
    id: "np-groceries",
    name: "Groceries",
    kind: "checklist",
    description: "Things to buy",
    created_at: "2026-08-01T00:00:00Z",
  },
  {
    id: "np-ideas",
    name: "Ideas",
    kind: "freeform",
    description: null,
    // Agent-created 20 minutes ago — inside the fresh-badge hour.
    created_at: "2026-08-15T11:40:00Z",
  },
];

const filed = (over: Partial<NoteSeed>): NoteSeed => ({
  id: "seed",
  notepad_id: "np-groceries",
  raw_text: "buy milk",
  body: "buy milk",
  structure: {},
  channel: "telegram",
  captured_at: "2026-08-15T11:00:00Z",
  triaged_at: "2026-08-15T11:00:05Z",
  triage: { model: "claude-haiku-4-5", attempts: 1 },
  created_at: "2026-08-15T11:00:00Z",
  ...over,
});

const notes: NoteSeed[] = [
  // A checklist item, done → strikethrough.
  filed({ id: "milk", raw_text: "buy milk", body: "buy milk", structure: { done: true } }),
  // A checklist item with a soon due date (2 days out).
  filed({
    id: "bread",
    raw_text: "buy bread",
    body: "buy bread",
    structure: { done: false, due_at: "2026-08-17T09:00:00Z" },
  }),
  // Body differs from raw_text → `show original` reveals it.
  filed({
    id: "mangoes",
    raw_text: "groceries: buy mangoes",
    body: "buy mangoes",
    structure: { done: false },
  }),
  // Agent-filed into Ideas — the provenance chip.
  filed({
    id: "app",
    notepad_id: "np-ideas",
    raw_text: "an app idea",
    body: "an app idea",
    structure: {},
  }),
  // Inbox: deliberately unfiled (triage ran, chose nothing).
  filed({
    id: "unfiled",
    notepad_id: null,
    raw_text: "random thought",
    body: "random thought",
    triaged_at: "2026-08-15T10:00:05Z",
  }),
  // Inbox: permanently failed (never triaged, attempts exhausted).
  filed({
    id: "stuck",
    notepad_id: null,
    raw_text: "cryptic note",
    body: "cryptic note",
    triaged_at: null,
    triage: { attempts: 3, last_error: "no fit" },
  }),
];

function stubServer({
  notepadRows = notepads,
  noteRows = notes,
  notepadsError = null as { message: string } | null,
  notesError = null as { message: string } | null,
} = {}) {
  createServerClient.mockResolvedValue({
    from(table: string) {
      const builder = {
        select() {
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        returns() {
          if (table === "notes_notepad") {
            return Promise.resolve({
              data: notepadsError ? null : notepadRows,
              error: notepadsError,
            });
          }
          return Promise.resolve({ data: notesError ? null : noteRows, error: notesError });
        },
      };
      return builder;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  createServerClient.mockReset();
});

async function renderPage() {
  render(await NotesManagerPage());
}

describe("Notes manager page — rail", () => {
  it("pins Inbox with its unfiled count and lists notepads with note counts, name-ordered", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    const buttons = within(rail).getAllByRole("button");

    // Inbox pinned first, then notepads in name order.
    expect(buttons[0]).toHaveTextContent("Inbox");
    expect(buttons[0]).toHaveTextContent("2"); // two unfiled notes
    expect(buttons[1]).toHaveTextContent("Groceries");
    expect(buttons[1]).toHaveTextContent("3"); // milk, bread, mangoes
    expect(buttons[2]).toHaveTextContent("Ideas");
    expect(buttons[2]).toHaveTextContent("1"); // the app idea
  });

  it("badges a freshly agent-created notepad as new", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    const ideas = within(rail).getByRole("button", { name: /Ideas/ });
    expect(within(ideas).getByText("new")).toBeInTheDocument();

    const groceries = within(rail).getByRole("button", { name: /Groceries/ });
    expect(within(groceries).queryByText("new")).not.toBeInTheDocument();
  });
});

describe("Notes manager page — inbox view", () => {
  it("opens on the inbox and distinguishes the unfiled states", async () => {
    stubServer();
    await renderPage();

    expect(screen.getByText("random thought")).toBeInTheDocument();
    expect(screen.getByText("cryptic note")).toBeInTheDocument();
    // The two lifecycle states are visibly different.
    expect(screen.getByText("unfiled")).toBeInTheDocument();
    expect(screen.getByText("couldn't file")).toBeInTheDocument();
  });

  it("shows the inbox-zero empty state when nothing is unfiled", async () => {
    stubServer({ noteRows: notes.filter((note) => note.notepad_id !== null) });
    await renderPage();

    expect(screen.getByText("Inbox zero — everything has been triaged.")).toBeInTheDocument();
  });
});

describe("Notes manager page — detail pane", () => {
  it("swaps to a notepad on rail click and renders its kind and description", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    fireEvent.click(within(rail).getByRole("button", { name: /Groceries/ }));

    expect(screen.getByRole("heading", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.getByText("checklist")).toBeInTheDocument();
    expect(screen.getByText("Things to buy")).toBeInTheDocument();
  });

  it("renders a checkbox and strikethrough for a done checklist item, and a due chip", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    fireEvent.click(within(rail).getByRole("button", { name: /Groceries/ }));

    const milk = screen.getByText("buy milk");
    expect(milk).toHaveClass("line-through");
    expect(screen.getByRole("img", { name: "done" })).toBeInTheDocument();

    // Bread is due in two days — a "soon" chip.
    expect(screen.getByText("17 Aug")).toBeInTheDocument();
  });

  it("reveals the original only when raw_text differs, on demand", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    fireEvent.click(within(rail).getByRole("button", { name: /Groceries/ }));

    // milk (raw == body) offers no reveal; mangoes (raw != body) does.
    const toggles = screen.getAllByRole("button", { name: "show original" });
    expect(toggles).toHaveLength(1);

    expect(screen.queryByText("groceries: buy mangoes")).not.toBeInTheDocument();
    fireEvent.click(toggles[0]);
    expect(screen.getByText("groceries: buy mangoes")).toBeInTheDocument();
  });

  it("shows the agent provenance chip on an agent-filed note", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    fireEvent.click(within(rail).getByRole("button", { name: /Ideas/ }));

    expect(screen.getByText("agent → Ideas")).toBeInTheDocument();
  });

  it("shows the placeholder subtitle when a notepad has no description", async () => {
    stubServer();
    await renderPage();

    const rail = screen.getByRole("navigation", { name: "Notepads" });
    fireEvent.click(within(rail).getByRole("button", { name: /Ideas/ }));

    expect(screen.getByText("add one to steer triage")).toBeInTheDocument();
  });
});

describe("Notes manager page — read failure", () => {
  it("surfaces a read error without taking the page down", async () => {
    stubServer({ notesError: { message: "permission denied" } });
    await renderPage();

    expect(
      screen.getByText(/Could not read the notes tables: permission denied/),
    ).toBeInTheDocument();
  });
});

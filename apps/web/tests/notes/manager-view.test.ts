import { describe, expect, it } from "vitest";

import {
  buildRail,
  dueChip,
  inboxState,
  isFresh,
  noteView,
  type NoteRow,
  type NotepadRow,
} from "@/lib/notes/manager-view";

/**
 * The rules the Variant-B manager renders notepads and notes by, asserted
 * against seeded rows rather than markup. These are ADR 0010's data-model
 * consequences — the checkbox test, the 3-day due window, the triage-lifecycle
 * split, the `show original` reveal — so they are the part of the page most
 * worth pinning independently of how it happens to look.
 */

const NOW = new Date("2026-08-15T12:00:00Z");

function notepad(over: Partial<NotepadRow> = {}): NotepadRow {
  return {
    id: "np-1",
    name: "Groceries",
    kind: "checklist",
    description: "Things to buy",
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function note(over: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "n-1",
    notepad_id: "np-1",
    raw_text: "buy mangoes",
    body: "buy mangoes",
    structure: {},
    channel: "telegram",
    captured_at: "2026-08-15T11:00:00Z",
    triaged_at: "2026-08-15T11:00:05Z",
    triage: { model: "claude-haiku-4-5", attempts: 1 },
    created_at: "2026-08-15T11:00:00Z",
    ...over,
  };
}

describe("buildRail", () => {
  it("counts the inbox and each notepad, sorted case-insensitively by name", () => {
    const notepads = [
      notepad({ id: "np-z", name: "zebra" }),
      notepad({ id: "np-i", name: "Ideas" }),
      notepad({ id: "np-a", name: "apples" }),
    ];
    const notes = [
      note({ id: "1", notepad_id: "np-i" }),
      note({ id: "2", notepad_id: "np-i" }),
      note({ id: "3", notepad_id: "np-a" }),
      note({ id: "4", notepad_id: null }),
      note({ id: "5", notepad_id: null }),
      note({ id: "6", notepad_id: null }),
    ];

    const rail = buildRail(notepads, notes, NOW);

    expect(rail.inboxCount).toBe(3);
    expect(rail.notepads.map((n) => n.name)).toEqual(["apples", "Ideas", "zebra"]);
    expect(rail.notepads.map((n) => n.count)).toEqual([1, 2, 0]);
  });

  it("flags a notepad created within the last hour as new", () => {
    const rail = buildRail(
      [
        notepad({ id: "fresh", name: "Fresh", created_at: "2026-08-15T11:30:00Z" }),
        notepad({ id: "old", name: "Old", created_at: "2026-08-15T10:00:00Z" }),
      ],
      [],
      NOW,
    );

    expect(rail.notepads.find((n) => n.id === "fresh")?.isNew).toBe(true);
    expect(rail.notepads.find((n) => n.id === "old")?.isNew).toBe(false);
  });
});

describe("isFresh", () => {
  it("is true just inside the hour and false at or before its edge", () => {
    expect(isFresh("2026-08-15T11:00:01Z", NOW)).toBe(true);
    expect(isFresh("2026-08-15T11:00:00Z", NOW)).toBe(false); // exactly an hour
    expect(isFresh("2026-08-15T13:00:00Z", NOW)).toBe(false); // in the future
    expect(isFresh("not a date", NOW)).toBe(false);
  });
});

describe("noteView checkbox", () => {
  it("renders a checkbox only when structure carries a done key", () => {
    expect(noteView(note({ structure: { done: false } }), "Groceries", NOW).checkbox).toEqual({
      done: false,
    });
    expect(noteView(note({ structure: { done: true } }), "Groceries", NOW).checkbox).toEqual({
      done: true,
    });
    // No done key — plain prose, never a checkbox, even in a checklist notepad.
    expect(
      noteView(note({ structure: { due_at: "2026-09-01T00:00:00Z" } }), "G", NOW).checkbox,
    ).toBe(null);
    expect(noteView(note({ structure: {} }), "Groceries", NOW).checkbox).toBe(null);
  });
});

describe("dueChip", () => {
  it("tones a due date overdue, soon (≤3d), or later", () => {
    expect(dueChip({ due_at: "2026-08-14T12:00:00Z" }, NOW)?.tone).toBe("overdue");
    expect(dueChip({ due_at: "2026-08-16T12:00:00Z" }, NOW)?.tone).toBe("soon");
    expect(dueChip({ due_at: "2026-08-18T12:00:00Z" }, NOW)?.tone).toBe("soon"); // exactly 3d
    expect(dueChip({ due_at: "2026-08-25T12:00:00Z" }, NOW)?.tone).toBe("later");
  });

  it("formats the label as a compact UTC day", () => {
    expect(dueChip({ due_at: "2026-08-18T09:00:00Z" }, NOW)?.label).toBe("18 Aug");
  });

  it("is null when there is no parseable due_at", () => {
    expect(dueChip({}, NOW)).toBe(null);
    expect(dueChip({ due_at: 12345 }, NOW)).toBe(null);
    expect(dueChip({ due_at: "whenever" }, NOW)).toBe(null);
  });
});

describe("inboxState", () => {
  it("splits the unfiled set on triaged_at and the attempts ceiling", () => {
    expect(inboxState(note({ notepad_id: null, triaged_at: "2026-08-15T11:00:05Z" }))).toBe(
      "unfiled",
    );
    expect(inboxState(note({ notepad_id: null, triaged_at: null, triage: { attempts: 1 } }))).toBe(
      "pending",
    );
    expect(inboxState(note({ notepad_id: null, triaged_at: null, triage: { attempts: 3 } }))).toBe(
      "failed",
    );
    // A payload predating the counter reads as zero attempts — still pending.
    expect(inboxState(note({ notepad_id: null, triaged_at: null, triage: {} }))).toBe("pending");
  });
});

describe("noteView provenance and original", () => {
  it("shows an agent chip pointing at the notepad for a triage-filed note", () => {
    expect(noteView(note(), "Groceries", NOW).agent).toEqual({ target: "Groceries" });
  });

  it("shows no agent chip for an unfiled note or one triage never placed", () => {
    expect(noteView(note({ notepad_id: null, triaged_at: null }), null, NOW).agent).toBe(null);
    expect(noteView(note({ triage: {} }), "Groceries", NOW).agent).toBe(null);
  });

  it("reveals the original only when raw_text differs from body", () => {
    expect(noteView(note({ raw_text: "same", body: "same" }), "G", NOW).original).toBe(null);
    expect(
      noteView(note({ raw_text: "groceries: buy milk", body: "buy milk" }), "G", NOW).original,
    ).toBe("groceries: buy milk");
  });

  it("carries an inbox state only for unfiled notes", () => {
    expect(noteView(note(), "Groceries", NOW).inboxState).toBe(null);
    expect(noteView(note({ notepad_id: null }), null, NOW).inboxState).toBe("unfiled");
  });
});

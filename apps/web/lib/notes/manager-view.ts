/**
 * How the Notes web manager reads: the pure rules that turn `notes_notepad` and
 * `notes_note` rows into the rail and the per-note rendering the page draws.
 *
 * Kept apart from the page and its React tree on purpose. Every decision the
 * Variant-B manager makes about a note — does it get a checkbox, is its due date
 * overdue, did the agent file it, is there an original worth revealing — is a
 * consequence of ADR 0010's data model, not of the layout. Holding them here
 * means they are asserted directly against seeded rows rather than dug out of
 * rendered markup, and the day a second surface reads the same tables (a mobile
 * view, a digest) it reuses these rules rather than reimplementing the ones that
 * are easy to get subtly wrong (the 3-day due window, the attempts ceiling).
 *
 * Read-only in this ticket (#78): nothing here writes. The mutations these views
 * imply — toggle, move, merge, re-triage — land in part 2 and will drive the
 * same view models.
 */

/** The `notes_notepad` columns the manager reads. */
export type NotepadRow = {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  created_at: string;
};

/** The `notes_note` columns the manager reads. */
export type NoteRow = {
  id: string;
  notepad_id: string | null;
  raw_text: string;
  body: string;
  /** Per-note structure (ADR 0010 dec. 2); absent keys mean "not that kind". */
  structure: Record<string, unknown> | null;
  channel: string;
  captured_at: string;
  /** null = never triaged / last attempt failed (ADR 0010 dec. 5). */
  triaged_at: string | null;
  /** `{ model, attempts, last_error }` (ADR 0012 dec. 5). */
  triage: Record<string, unknown> | null;
  created_at: string;
};

/** A notepad as the left rail draws it: `• name … count`, with the fresh badge. */
export type RailNotepad = {
  id: string;
  name: string;
  kind: string;
  count: number;
  /** Agent-created within the last hour — carries a `new` badge (spec area F). */
  isNew: boolean;
};

export type Rail = {
  /** The `notepad_id IS NULL` set — a pinned rail item, not a notepad (dec. 5). */
  inboxCount: number;
  notepads: RailNotepad[];
};

/** How close a due date is, which is the whole of how its chip is coloured. */
export type DueTone = "overdue" | "soon" | "later";

export type DueChip = { label: string; tone: DueTone };

/**
 * Where an unfiled note sits in the triage lifecycle (ADR 0012 dec. 3), read off
 * the orthogonal `triaged_at` × attempts axes:
 * - `unfiled`  — triage ran and chose no notepad (a deliberate inbox keep).
 * - `pending`  — not yet triaged, attempts remain (`< 3`).
 * - `failed`   — not triaged, attempts exhausted (`= 3`); a visible dead-end.
 */
export type InboxState = "unfiled" | "pending" | "failed";

export type NoteView = {
  id: string;
  body: string;
  /** Present iff `structure` carries a `done` key (dec. 2) — then a checkbox renders. */
  checkbox: { done: boolean } | null;
  /** Present iff `structure.due_at` parses — a mono chip toned by nearness. */
  due: DueChip | null;
  /** Present iff the agent filed this note — `agent → <notepad>` (spec area F). */
  agent: { target: string } | null;
  /** `raw_text` iff it differs from `body`; the `show original` reveal (dec. 6). */
  original: string | null;
  /** Present iff the note is unfiled (inbox context) — its lifecycle state. */
  inboxState: InboxState | null;
};

const HOUR_MS = 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
/** The retry ceiling triage stops at (ADR 0012 dec. 4); at it, a note is failed. */
const ATTEMPTS_CEILING = 3;

/**
 * The rail: the inbox count, then every notepad in name order with its note
 * count and fresh badge.
 *
 * Counts are derived here from the notes rather than read as a column, because
 * `notepad_id IS NULL` (the inbox) and `notepad_id = <id>` (a notepad) are the
 * same one pass over the notes — and a stored count would be one more thing for
 * a move to keep in step.
 *
 * Name order is case-insensitive: "shopping" must not sort below "Ideas" just
 * for its case, and the unique index is already on `lower(trim(name))`, so the
 * rail orders the way identity is defined.
 */
export function buildRail(notepads: NotepadRow[], notes: NoteRow[], now: Date): Rail {
  const counts = new Map<string, number>();
  let inboxCount = 0;

  for (const note of notes) {
    if (note.notepad_id === null) {
      inboxCount += 1;
    } else {
      counts.set(note.notepad_id, (counts.get(note.notepad_id) ?? 0) + 1);
    }
  }

  const railNotepads: RailNotepad[] = notepads
    .map((notepad) => ({
      id: notepad.id,
      name: notepad.name,
      kind: notepad.kind,
      count: counts.get(notepad.id) ?? 0,
      isNew: isFresh(notepad.created_at, now),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  return { inboxCount, notepads: railNotepads };
}

/**
 * A note as the detail list renders it, given the name of the notepad it sits in
 * (`null` in the inbox, where there is no notepad to point an agent chip at).
 *
 * The checkbox is keyed off the *presence* of a `done` key, not its value — a
 * note with `done: false` is an unchecked item, and a note with no `done` key at
 * all is plain prose that never grows a checkbox (dec. 2). Confusing the two
 * would put a checkbox on every note in a checklist notepad, structured or not.
 */
export function noteView(note: NoteRow, notepadName: string | null, now: Date): NoteView {
  const structure = note.structure ?? {};

  const checkbox =
    "done" in structure ? { done: Boolean((structure as { done?: unknown }).done) } : null;

  const unfiled = note.notepad_id === null;

  return {
    id: note.id,
    body: note.body,
    checkbox,
    due: dueChip(structure, now),
    // Only a filed note the agent placed carries the chip: it points at the
    // notepad, so an inbox note (no notepad) never has one, and a note with no
    // triage model was not placed by triage. In this read-only build there is no
    // manual-override flag yet, so a filed-by-triage note is agent-filed; the
    // "you filed this" flip arrives with moves in part 2.
    agent:
      !unfiled && note.triaged_at !== null && hasModel(note.triage) && notepadName !== null
        ? { target: notepadName }
        : null,
    original: note.raw_text === note.body ? null : note.raw_text,
    inboxState: unfiled ? inboxState(note) : null,
  };
}

/** Whether a timestamp is inside the last hour of `now` (the `new` badge window). */
export function isFresh(createdAt: string, now: Date): boolean {
  const created = Date.parse(createdAt);

  if (Number.isNaN(created)) return false;

  const age = now.getTime() - created;

  return age >= 0 && age < HOUR_MS;
}

/**
 * The lifecycle state of an *unfiled* note, off `triaged_at` and the attempt
 * count. Callers gate this on `notepad_id IS NULL` — a filed note has no inbox
 * state to read.
 */
export function inboxState(note: NoteRow): InboxState {
  if (note.triaged_at !== null) return "unfiled";

  return attempts(note.triage) >= ATTEMPTS_CEILING ? "failed" : "pending";
}

/**
 * The due chip for a note's structure, or `null` when there is no parseable
 * `due_at`. Overdue and "within three days" are the two thresholds ADR 0010
 * gives colour to; everything further out is a plain `later`.
 */
export function dueChip(structure: Record<string, unknown>, now: Date): DueChip | null {
  if (!("due_at" in structure)) return null;

  const raw = (structure as { due_at?: unknown }).due_at;

  if (typeof raw !== "string") return null;

  const due = Date.parse(raw);

  if (Number.isNaN(due)) return null;

  const delta = due - now.getTime();
  const tone: DueTone = delta < 0 ? "overdue" : delta <= THREE_DAYS_MS ? "soon" : "later";

  return { label: formatDueLabel(due), tone };
}

/** A due date as a compact `12 Aug` mono chip — UTC, matching the sync's zone. */
function formatDueLabel(due: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(due));
}

/** `triage.attempts` as a number, or 0 when the payload predates the counter. */
function attempts(triage: Record<string, unknown> | null): number {
  const value = triage?.attempts;

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Whether triage recorded a model — the mark that triage, not a human, placed it. */
function hasModel(triage: Record<string, unknown> | null): boolean {
  return typeof triage?.model === "string" && triage.model.trim() !== "";
}

import { NotesManager, type InboxDetail, type NotepadDetail } from "@/components/notes-manager";
import {
  buildRail,
  isFresh,
  noteView,
  type NoteRow,
  type NotepadRow,
} from "@/lib/notes/manager-view";
import { createClient } from "@/lib/supabase/server";

/**
 * The Notes module's front door — the Variant-B (Library) manager: a rail of
 * notepads with the inbox pinned on top, and a detail pane of the selected
 * notepad's notes (prototype #62, invariants from ADR 0010).
 *
 * Read-only in this ticket (#78, spec build area F part 1). The rendering rules —
 * which note gets a checkbox, when a due date is overdue, whether the agent filed
 * it, whether there is an original worth revealing — all live in `manager-view`,
 * so this page is only the two reads and the shape they feed the pane. The
 * mutations they imply (toggle, move, merge, re-triage) and the `modules.ts` flip
 * to `live` land in part 2.
 *
 * Both reads go through the signed-in session and the anon key, so `is_authorized`
 * RLS is the gate here exactly as it is on the writer — the page renders these
 * tables only for the one authorized user.
 */

export const dynamic = "force-dynamic";

/**
 * Generous against what the table can hold: one phone message is one note, so the
 * row count grows at the pace a person captures, not a sync. Worth revisiting as a
 * per-notepad paged read long before it bites.
 */
const NOTE_LIMIT = 1000;

export default async function NotesManagerPage() {
  const supabase = await createClient();

  // Two independent reads, issued together — the page is as slow as the slower.
  const [notepads, notes] = await Promise.all([
    supabase
      .from("notes_notepad")
      .select("id, name, kind, description, created_at")
      .order("name")
      .returns<NotepadRow[]>(),
    supabase
      .from("notes_note")
      .select(
        "id, notepad_id, raw_text, body, structure, channel, captured_at, triaged_at, triage, created_at",
      )
      // Newest capture first: the inbox reads as a triage queue, and a notepad's
      // most recent additions sit where the eye lands.
      .order("created_at", { ascending: false })
      .limit(NOTE_LIMIT)
      .returns<NoteRow[]>(),
  ]);

  const error = notepads.error ?? notes.error;
  const notepadRows = notepads.data ?? [];
  const noteRows = notes.data ?? [];

  // One clock for the whole render: `isFresh` and the due-window both read `now`,
  // and a server value handed down keeps them from disagreeing with a client
  // `new Date()` that reads a different second (or zone) at hydration.
  const now = new Date();

  const rail = buildRail(notepadRows, noteRows, now);

  const notepadDetails: NotepadDetail[] = notepadRows
    .map((notepad) => ({
      id: notepad.id,
      name: notepad.name,
      kind: notepad.kind,
      description: notepad.description,
      isNew: isFresh(notepad.created_at, now),
      notes: noteRows
        .filter((note) => note.notepad_id === notepad.id)
        .map((note) => noteView(note, notepad.name, now)),
    }))
    // Name order, matching the rail, so the pane the rail selects is the pane
    // that renders.
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const inbox: InboxDetail = {
    // An inbox note is `notepad_id IS NULL` by definition, so there is no notepad
    // name to hand `noteView` — and no agent chip to draw (it points at one).
    notes: noteRows
      .filter((note) => note.notepad_id === null)
      .map((note) => noteView(note, null, now)),
  };

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <p className="border-hairline text-negative border-t pt-3 text-[13px]">
          Could not read the notes tables: {error.message}
        </p>
      ) : null}

      <NotesManager rail={rail} notepads={notepadDetails} inbox={inbox} />
    </div>
  );
}

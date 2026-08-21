"use client";

import { useState } from "react";

import type { DueTone, InboxState, NoteView, Rail } from "@/lib/notes/manager-view";

/**
 * The Variant-B (Library) Notes manager: a notepad rail with the inbox pinned on
 * top, and a detail pane of the selected notepad's notes (prototype #62). All the
 * rendering *rules* live in `manager-view` and arrive here already resolved — this
 * component is the layout and the one piece of state the rail has, which selection
 * is. Read-only in this ticket (#78): the checkbox, `+ New notepad`, and the note
 * actions render as they will look, but the writes behind them land in part 2.
 */

export type NotepadDetail = {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  isNew: boolean;
  notes: NoteView[];
};

export type InboxDetail = { notes: NoteView[] };

/** The rail's selection — the pinned inbox, or a notepad by id. */
type Selection = { kind: "inbox" } | { kind: "notepad"; id: string };

export function NotesManager({
  rail,
  notepads,
  inbox,
}: {
  rail: Rail;
  notepads: NotepadDetail[];
  inbox: InboxDetail;
}) {
  const [selection, setSelection] = useState<Selection>({ kind: "inbox" });

  const selectedNotepad =
    selection.kind === "notepad"
      ? notepads.find((notepad) => notepad.id === selection.id)
      : undefined;

  return (
    <div className="border-hairline grid grid-cols-[232px_minmax(0,1fr)] overflow-hidden rounded-lg border">
      <NotesRail
        rail={rail}
        selection={selection}
        onSelect={setSelection}
        // A notepad selected then deleted elsewhere would leave a dangling id;
        // falling back to the inbox is the one honest thing the pane can show.
        selectionMissing={selection.kind === "notepad" && selectedNotepad === undefined}
      />

      <section className="min-w-0 px-7 py-6">
        {selection.kind === "inbox" || selectedNotepad === undefined ? (
          <InboxPane inbox={inbox} />
        ) : (
          <NotepadPane notepad={selectedNotepad} />
        )}
      </section>
    </div>
  );
}

function NotesRail({
  rail,
  selection,
  onSelect,
  selectionMissing,
}: {
  rail: Rail;
  selection: Selection;
  onSelect: (next: Selection) => void;
  selectionMissing: boolean;
}) {
  const inboxActive = selection.kind === "inbox" || selectionMissing;

  return (
    <nav
      aria-label="Notepads"
      className="border-hairline bg-panel flex flex-col gap-1 border-r px-2 py-3"
    >
      <RailButton
        active={inboxActive}
        onClick={() => onSelect({ kind: "inbox" })}
        // The inbox is the notepad_id IS NULL query, marked by the accent dot —
        // a pinned rail item, not a notepad (ADR 0010 dec. 5).
        leading={<span aria-hidden className="bg-accent size-1.5 flex-none rounded-full" />}
        label="Inbox"
        count={rail.inboxCount}
      />

      <hr className="border-hairline my-1" />

      <ul className="flex flex-col gap-0.5">
        {rail.notepads.map((notepad) => (
          <li key={notepad.id}>
            <RailButton
              active={
                selection.kind === "notepad" && selection.id === notepad.id && !selectionMissing
              }
              onClick={() => onSelect({ kind: "notepad", id: notepad.id })}
              leading={
                <span aria-hidden className="text-muted flex-none">
                  •
                </span>
              }
              label={notepad.name}
              count={notepad.count}
              badge={notepad.isNew ? <NewBadge /> : null}
            />
          </li>
        ))}
      </ul>

      <div className="flex-1" />

      {/* Foot affordance; its wiring lands in part 2, so it is inert for now. */}
      <button
        type="button"
        disabled
        className="text-muted cursor-not-allowed rounded-md px-2.5 py-2 text-left text-[12.5px] opacity-60"
      >
        + New notepad
      </button>
    </nav>
  );
}

function RailButton({
  active,
  onClick,
  leading,
  label,
  count,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  leading: React.ReactNode;
  label: string;
  count: number;
  badge?: React.ReactNode;
}) {
  const className = [
    "flex w-full items-center gap-2 rounded-md border-l-2 px-2.5 py-2 text-left text-[13px]",
    active
      ? "border-l-accent bg-panel-2 text-ink"
      : "border-l-transparent text-muted hover:bg-panel-2 hover:text-ink",
  ].join(" ");

  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={className}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
      <span className="text-muted flex-none font-mono text-[11.5px] tabular-nums">{count}</span>
    </button>
  );
}

function NewBadge() {
  return (
    <span className="border-accent text-accent flex-none rounded-full border px-1.5 py-px text-[9.5px] tracking-[0.06em] uppercase">
      new
    </span>
  );
}

function NotepadPane({ notepad }: { notepad: NotepadDetail }) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-ink text-[16px] font-medium">{notepad.name}</h2>
          <KindChip kind={notepad.kind} />
          {notepad.isNew ? <NewBadge /> : null}
        </div>
        {notepad.description ? (
          <p className="text-muted text-[12.5px]">{notepad.description}</p>
        ) : (
          <p className="text-muted text-[12.5px] italic opacity-70">add one to steer triage</p>
        )}
      </header>

      <NoteList notes={notepad.notes} emptyState="No notes here yet." />
    </div>
  );
}

function InboxPane({ inbox }: { inbox: InboxDetail }) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <p className="text-muted text-[12.5px]">
          <b className="text-ink font-medium">Inbox</b> / unfiled
        </p>
      </header>

      <NoteList notes={inbox.notes} emptyState="Inbox zero — everything has been triaged." inbox />
    </div>
  );
}

function KindChip({ kind }: { kind: string }) {
  return (
    <span className="border-hairline text-muted rounded-full border px-2 py-[2px] text-[10.5px] tracking-[0.04em]">
      {kind}
    </span>
  );
}

function NoteList({
  notes,
  emptyState,
  inbox = false,
}: {
  notes: NoteView[];
  emptyState: string;
  inbox?: boolean;
}) {
  if (notes.length === 0) {
    return <p className="text-muted py-6 text-center text-[13px]">{emptyState}</p>;
  }

  return (
    <ul className="border-hairline flex flex-col border-t">
      {notes.map((note) => (
        <NoteItem key={note.id} note={note} inbox={inbox} />
      ))}
    </ul>
  );
}

function NoteItem({ note, inbox }: { note: NoteView; inbox: boolean }) {
  const [showOriginal, setShowOriginal] = useState(false);

  const done = note.checkbox?.done ?? false;

  return (
    <li className="border-hairline flex flex-col gap-1.5 border-b py-2.5">
      <div className="flex items-start gap-2.5">
        {note.checkbox ? <Checkbox done={done} /> : null}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[13.5px] ${done ? "text-muted line-through" : "text-ink"}`}>
              {note.body}
            </span>
            {note.due ? <DueChip label={note.due.label} tone={note.due.tone} /> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
            {inbox && note.inboxState ? <InboxStateChip state={note.inboxState} /> : null}
            {note.agent ? <AgentChip target={note.agent.target} /> : null}
            {note.original ? (
              <button
                type="button"
                onClick={() => setShowOriginal((open) => !open)}
                className="text-muted hover:text-ink underline underline-offset-2"
              >
                {showOriginal ? "hide original" : "show original"}
              </button>
            ) : null}
          </div>

          {note.original && showOriginal ? (
            <p className="border-hairline text-muted bg-panel mt-0.5 rounded-md border px-2.5 py-1.5 font-mono text-[11.5px] whitespace-pre-wrap">
              {note.original}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * A read-only rendering of a checklist item's state. Not an `<input>`: toggling
 * is a write, and a live checkbox that did nothing on click would lie about it.
 */
function Checkbox({ done }: { done: boolean }) {
  return (
    <span
      role="img"
      aria-label={done ? "done" : "not done"}
      className={[
        "mt-0.5 grid size-4 flex-none place-items-center rounded-[4px] border text-[10px]",
        done ? "border-accent bg-accent text-bg" : "border-hairline text-transparent",
      ].join(" ")}
    >
      ✓
    </span>
  );
}

function DueChip({ label, tone }: { label: string; tone: DueTone }) {
  const color =
    tone === "overdue"
      ? "text-negative border-negative"
      : tone === "soon"
        ? "text-accent border-accent"
        : "text-muted border-hairline";

  return (
    <span
      className={`rounded-full border px-1.5 py-px font-mono text-[10.5px] tabular-nums ${color}`}
    >
      {label}
    </span>
  );
}

function AgentChip({ target }: { target: string }) {
  return (
    <span className="border-hairline text-muted rounded-full border px-2 py-px text-[10.5px]">
      agent → {target}
    </span>
  );
}

/**
 * The unfiled note's lifecycle state (ADR 0012 dec. 3), the thing that tells a
 * deliberate inbox keep from a note triage never reached or gave up on.
 */
function InboxStateChip({ state }: { state: InboxState }) {
  const copy: Record<InboxState, { label: string; className: string }> = {
    unfiled: { label: "unfiled", className: "text-muted border-hairline" },
    pending: { label: "pending triage", className: "text-accent border-accent" },
    failed: { label: "couldn't file", className: "text-negative border-negative" },
  };
  const { label, className } = copy[state];

  return (
    <span className={`rounded-full border px-2 py-px text-[10.5px] ${className}`}>{label}</span>
  );
}

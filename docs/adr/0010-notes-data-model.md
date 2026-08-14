# Notes module data model — notepads and notes

**Status**: accepted

The Notes module (map [#55](https://github.com/bsim0927/ben-os/issues/55)) captures a message from a
phone channel (Telegram for v1), lands it in Supabase, and an agent triages it into the right
**notepad** — creating one if none fits — deciding its structure along the way. This ADR (0010) fixes the
storage shape those two things (capture, triage) read and write, resolving ticket
[#58](https://github.com/bsim0927/ben-os/issues/58). It follows the baseline schema conventions
(ADR 0001) — every table below is on that baseline: `id uuid` pk, `created_at`/`updated_at` with the
shared `set_updated_at()` trigger, one `FOR ALL USING (is_authorized()) WITH CHECK (is_authorized())`
RLS policy, hard delete, the `notes_` name prefix, and the destructive-guard posture the `financials_*`
tables carry (truncate/drop/bulk-delete guards).

Two tables: `notes_notepad` (the managed container) and `notes_note` (a single captured note).

## Decisions

1. **"Checklist-ness" is a hybrid — a notepad property first, with per-note exceptions.**
   `notes_notepad.kind` (`'freeform' | 'checklist' | 'list' | …`) is the primary answer to "is this a
   checklist": it sets the default UI rendering and steers triage ("this is the groceries checklist,
   make what lands here an item"). But individual notes still carry their own optional structure, so a
   due date can sit on one note in an otherwise-plain notepad. Rejected: pure per-notepad kind (can't
   express a one-off structured note) and pure per-note structure (loses the notepad-level steer triage
   and the UI both want).

2. **Per-note structure is a `jsonb` payload, not typed columns.** `notes_note.structure jsonb` holds
   the inferred structure, e.g. `{"done": false, "due_at": "2026-08-12T09:00:00Z"}`. Absent keys mean
   "not that kind of structure" (no `done` key ⇒ not a checklist item). This departs from the
   Financials precedent of explicit typed columns, deliberately: a general practice for this project is
   to **design for expansion**, and structure is the field most likely to grow new kinds. The cost is
   SQL-opacity; when a key needs cross-notepad querying (e.g. `due_at` surfacing in Calendar, a fog
   item on the map) we add a GIN or expression index for that key rather than a column.

3. **Notepad identity is a normalized name, enforced in the DB _and_ trusted to triage.** A `unique`
   index on `lower(trim(name))` is the hard backstop against literal duplicates ("Groceries" vs
   "groceries"). Triage is the _primary_ dedup mechanism by construction — it sees the existing
   notepads as its choose-from set and is prompted to reuse. Genuinely-different-name-same-thing cases
   ("Groceries" vs "Shopping") are caught by neither and are reconciled with an explicit **merge** in
   the web manager (reassign the notes' `notepad_id`, delete the emptied notepad).

4. **A notepad carries a `description`, distinct from its name, to make semantic reuse reliable.**
   `notes_notepad.description text` (nullable) is a short purpose line — e.g. _"Groceries and household
   items to buy."_ Triage writes it on creation and reads it (with the name) when deciding where a note
   like "buy mangoes" — sent with no notepad named — belongs. It doubles as a UI subtitle and is
   editable, so refining a notepad's purpose steers future triage. The _matching mechanism itself_ is
   the triage-model ticket's ([#60](https://github.com/bsim0927/ben-os/issues/60)) concern; this field
   is the data-model lever that supports it.

5. **A note can be unfiled; `notepad_id` is nullable and `triaged_at` records whether triage ran.**
   There is necessarily a moment between capture and triage — the row lands first, an agent files it
   after — and triage can fail or defer. So `notes_note.notepad_id uuid null` references
   `notes_notepad`, and `notepad_id IS NULL` _is_ the inbox (a query, not a magic "Inbox" notepad that
   merge/rename/delete would have to special-case). `notes_note.triaged_at timestamptz null`
   disambiguates "never triaged / last attempt failed" (`null`, re-triage picks these up) from "triage
   has run". The fuller triage lifecycle (retry counts, failure reasons, on-arrival vs batched) is
   [#60](https://github.com/bsim0927/ben-os/issues/60)'s to design; in the design-for-expansion spirit
   it can land as a `triage jsonb` when that ticket resolves.

6. **The raw capture is preserved immutably, separate from the working content.**
   `notes_note.raw_text text not null` is exactly what arrived and never changes; `notes_note.body text
not null` starts equal to it and is what triage refines and the user edits. Keeping the pristine
   original is what lets **re-triage** re-read the source rather than a previously-rewritten version,
   and gives any "correct where this got filed" feedback loop something to work from. `raw_text` is
   stored but not shown by default — the web manager tucks it behind a "show raw text" affordance
   (prototype ticket [#62](https://github.com/bsim0927/ben-os/issues/62)).

7. **Provenance is channel-agnostic: a `channel` discriminator plus a `source` jsonb.**
   `notes_note.channel text not null` (`'telegram'` today, an iOS widget later) and `notes_note.source
jsonb not null default '{}'` for that channel's identifiers — the note table hardcodes no Telegram
   columns. This mirrors the Financials `provider` + `extra`-jsonb multi-provider pattern.
   `notes_note.captured_at timestamptz not null` is the sender's timestamp (Telegram's Unix-seconds
   `date`), kept distinct from `created_at` (row-insert time) exactly as a Holding's provider `as_of` is
   kept distinct from its job run.

8. **Capture is idempotent at the DB layer.** Telegram redelivers a webhook when the handler doesn't
   `200` fast enough, so the same note can arrive twice. Every adapter puts a stable dedup key at
   `source->>'external_id'` (Telegram: the `update_id`), and a **partial unique index** on `(channel,
(source->>'external_id')) WHERE source->>'external_id' IS NOT NULL` makes a redelivery no-op —
   the direct analogue of transactions deduping on `(account_id, provider_transaction_id)`. Channels
   with no natural id are simply exempt (partial). The _adapter's_ job of populating `source.external_id`
   from each channel is the ingest-boundary ticket's
   ([#59](https://github.com/bsim0927/ben-os/issues/59)) to specify.

## Schema sketch

Not applied — this ADR is the plan. When built, this becomes a `notes_schema` migration. Note that a
new-table migration adding destructive-guard triggers can't be applied through the Supabase MCP server
(the SQL guard blocks the guard triggers themselves); it is applied out-of-band at build time.

```sql
create table public.notes_notepad (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'freeform',
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- literal-duplicate backstop (decision 3)
create unique index notes_notepad_name_key on public.notes_notepad (lower(trim(name)));

create table public.notes_note (
  id          uuid primary key default gen_random_uuid(),
  notepad_id  uuid references public.notes_notepad (id),        -- null = unfiled/inbox (decision 5)
  raw_text    text not null,                                    -- immutable original (decision 6)
  body        text not null,                                    -- editable working content (decision 6)
  structure   jsonb not null default '{}'::jsonb,               -- per-note structure (decision 2)
  channel     text not null,                                    -- channel-agnostic (decision 7)
  source      jsonb not null default '{}'::jsonb,               -- channel-specific ids (decision 7)
  captured_at timestamptz not null,                             -- sender's timestamp (decision 7)
  triaged_at  timestamptz,                                      -- null = pending/failed (decision 5)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- webhook idempotency (decision 8)
create unique index notes_note_channel_external_id_key
  on public.notes_note (channel, (source->>'external_id'))
  where source->>'external_id' is not null;

-- ADR 0001 baseline for both tables: shared updated_at trigger, is_authorized() RLS, destructive guards
-- (elided here; applied uniformly per ADR 0001 and the financials_* precedent).
```

## Consequences

- Triage ([#60](https://github.com/bsim0927/ben-os/issues/60)) reads the notepad set (`name` +
  `kind` + `description`) as its choose-or-create input, and writes `notepad_id`, `body`, `structure`,
  `triaged_at`. Semantic matching quality rides on `description`, which this schema now provides.
- The ingest boundary ([#59](https://github.com/bsim0927/ben-os/issues/59)) must normalize each channel
  into `raw_text` + `channel` + `source` (including `source.external_id`) + `captured_at`. The schema
  is agnostic to how many channels exist.
- The web manager ([#62](https://github.com/bsim0927/ben-os/issues/62)) renders notepads by `kind`,
  checkboxes off `structure.done`, edits `body`, reveals `raw_text` on demand, and implements merge as
  a notepad-reassign-then-delete.
- Notepad lifecycle/archiving is left unspecified; if it arrives, an additive column (`archived_at`, or
  a `status`) fits without disturbing the above.

```

```

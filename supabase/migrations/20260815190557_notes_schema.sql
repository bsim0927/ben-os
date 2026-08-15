-- The Notes module's storage: notepads and the notes filed into them.
--
-- Shapes come from docs/adr/0010-notes-data-model.md (the data model) and its
-- schema delta in docs/adr/0012-notes-triage-model.md (the `triage jsonb`
-- column and the sweep index), on the baseline in
-- docs/adr/0001-baseline-supabase-schema-conventions.md. Both ADRs' DDL is
-- folded into this one migration, exactly as build area A of
-- docs/specs/notes-module-build-spec.md prescribes.
--
-- Applied OUT-OF-BAND at build time, not through the Supabase MCP server. The
-- destructive-guard triggers below are the same ones the SQL guard
-- (.claude/hooks/guard-supabase-sql.py) refuses to let through, because a
-- migration that installs guard triggers looks exactly like one trying to
-- disable them. That refusal is the guard working; the migration is applied by
-- hand rather than by routing around it.

-- ---------------------------------------------------------------------------
-- Notepads
-- ---------------------------------------------------------------------------

-- The managed container a note is filed into (ADR 0010). `kind` sets the
-- default rendering and steers triage ('freeform' | 'checklist' | 'list' | …);
-- it is free text rather than an enum in the design-for-expansion spirit, since
-- new kinds are exactly what this field is expected to grow. `description` is a
-- short purpose line triage writes on creation and reads when placing a note
-- (ADR 0010 dec. 4) — nullable, because a hand-made notepad may not have one yet.
create table public.notes_notepad (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'freeform',
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The literal-duplicate backstop (ADR 0010 dec. 3): "Groceries" and "groceries"
-- are the same notepad. Triage is the primary dedup by construction — it sees
-- the existing notepads and is prompted to reuse — so this index catches only
-- the case triage misses, and is what `new_notepad` upserts on.
create unique index notes_notepad_name_key
  on public.notes_notepad (lower(trim(name)));

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------

-- A single captured note. It lands first with `notepad_id`/`triaged_at` null
-- (the inbox), and triage fills them in later (ADR 0010 dec. 5).
create table public.notes_note (
  id uuid primary key default gen_random_uuid(),
  -- null = unfiled/inbox (ADR 0010 dec. 5). The inbox is this predicate, not a
  -- magic "Inbox" notepad that merge/rename/delete would have to special-case.
  -- `on delete set null` so deleting a non-empty notepad orphans its notes back
  -- to the inbox rather than blocking until empty (build spec: "Delete a
  -- non-empty notepad -> orphan its notes to Inbox"), the same choice
  -- financials_transaction.category_id makes.
  notepad_id uuid references public.notes_notepad (id) on delete set null,
  -- The pristine original, exactly as it arrived; never rewritten (dec. 6). This
  -- is what lets re-triage re-read the source rather than a previous rewrite.
  raw_text text not null,
  -- The working content triage refines and the user edits; starts = raw_text.
  body text not null,
  -- Per-note inferred structure, e.g. {"done": false, "due_at": "…"} (dec. 2).
  -- Absent keys mean "not that kind of structure" (no `done` ⇒ not a checklist
  -- item). jsonb rather than typed columns because structure is the field most
  -- likely to grow new kinds; a key that needs cross-notepad querying earns an
  -- expression index then, not a column now.
  structure jsonb not null default '{}'::jsonb,
  -- Channel-agnostic provenance (dec. 7): a discriminator ('telegram' today, an
  -- iOS widget later) plus a per-channel `source` bag of identifiers. Mirrors
  -- the financials provider + extra-jsonb multi-provider pattern; the note table
  -- hardcodes no Telegram columns.
  channel text not null,
  source jsonb not null default '{}'::jsonb,
  -- The sender's timestamp (Telegram's Unix-seconds `date`), kept distinct from
  -- `created_at` (row-insert time) exactly as a holding's `as_of` is (dec. 7).
  captured_at timestamptz not null,
  -- null = never triaged / last attempt failed (re-triage picks these up); set
  -- = triage has run (ADR 0010 dec. 5).
  triaged_at timestamptz,
  -- The triage lifecycle payload: { model, attempts, last_error } (ADR 0012
  -- dec. 5). Additive to the ADR 0010 schema, in the design-for-expansion
  -- spirit ADR 0010 anticipated.
  triage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Capture idempotency (ADR 0010 dec. 8). Telegram redelivers a webhook when the
-- handler doesn't 200 fast enough; every adapter puts a stable dedup key at
-- source->>'external_id' (Telegram: the update_id), and this partial unique
-- index makes the redelivery a no-op on `insert … on conflict do nothing`.
-- Channels with no natural id are simply exempt (the partial WHERE).
create unique index notes_note_channel_external_id_key
  on public.notes_note (channel, (source->>'external_id'))
  where source->>'external_id' is not null;

-- The triage sweep's takeable set (ADR 0012 dec. 5): the untriaged tail, newest
-- first. Partial so it stays cheap as the filed majority of the table grows.
create index notes_note_untriaged_idx
  on public.notes_note (created_at)
  where triaged_at is null;

-- The web manager's core read: one notepad's notes (ADR 0010 Consequences). Also
-- what the `on delete set null` above scans when a notepad is deleted. Partial
-- on the filed rows, mirroring financials_transaction's category_id index — the
-- unfiled inbox is served by notes_note_untriaged_idx instead.
create index notes_note_notepad_id_idx
  on public.notes_note (notepad_id)
  where notepad_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

-- Both tables are edited in place (a notepad renamed, a note's body/triage
-- updated), so both carry the shared BEFORE UPDATE trigger — unlike the
-- insert-only financials_holding, which ADR 0004 exempted.
create trigger notes_notepad_set_updated_at
  before update on public.notes_notepad
  for each row execute function public.set_updated_at();

create trigger notes_note_set_updated_at
  before update on public.notes_note
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- One policy per table, the ADR 0001 baseline: every access is gated on
-- is_authorized(). This is the single gate every write path leans on — web,
-- and the server-originated ingest/triage/correction writes that go through
-- lib/notes/db.ts under the `authenticated` role (ADR 0011 dec. 4).
alter table public.notes_notepad enable row level security;
alter table public.notes_note enable row level security;

create policy notes_notepad_authorized on public.notes_notepad
  for all using (public.is_authorized()) with check (public.is_authorized());

create policy notes_note_authorized on public.notes_note
  for all using (public.is_authorized()) with check (public.is_authorized());

grant select, insert, update, delete on
  public.notes_notepad,
  public.notes_note
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Destructive guards
-- ---------------------------------------------------------------------------
--
-- The same tripwires the financials_* tables carry
-- (20260802205533_financials_destructive_guards.sql): a truncate, a drop, or a
-- single delete of more than 100 rows fails loudly and requires a deliberate
--
--   begin; set local ben_os.allow_bulk_delete = 'on'; <statement>; commit;
--
-- to repeat. The guard functions (guard_bulk_delete, guard_truncate,
-- bulk_delete_allowed) already exist and are table-agnostic, so the delete and
-- truncate guards are just attached here. The drop event trigger is per-name —
-- the financials one matches `financials\_%` and won't cover `notes_*` — so a
-- parallel `notes_guard_drop` is created below.
--
-- These notes are not re-fetchable either: a captured note has no upstream to
-- re-sync from, so a dropped table or a stray delete is a hole in the record.

create or replace function public.guard_notes_drop()
returns event_trigger
language plpgsql
as $$
declare
  dropped record;
begin
  if public.bulk_delete_allowed() then
    return;
  end if;

  for dropped in select * from pg_event_trigger_dropped_objects() loop
    if dropped.object_type = 'table'
       and dropped.schema_name = 'public'
       and dropped.object_name like 'notes\_%'
    then
      raise exception 'Refusing to drop %.%.', dropped.schema_name, dropped.object_name
        using hint =
          'This data cannot be re-fetched. If deliberate: begin; '
          || 'set local ben_os.allow_bulk_delete = ''on''; <statement>; commit;';
    end if;
  end loop;
end $$;

drop event trigger if exists notes_guard_drop;
create event trigger notes_guard_drop on sql_drop
  execute function public.guard_notes_drop();

do $$
declare
  t text;
begin
  foreach t in array array['notes_notepad', 'notes_note'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard_delete', t);
    execute format(
      'create trigger %I after delete on public.%I '
      || 'referencing old table as deleted for each statement '
      || 'execute function public.guard_bulk_delete()', t || '_guard_delete', t);

    execute format('drop trigger if exists %I on public.%I', t || '_guard_truncate', t);
    execute format(
      'create trigger %I before truncate on public.%I '
      || 'for each statement execute function public.guard_truncate()',
      t || '_guard_truncate', t);
  end loop;
end $$;

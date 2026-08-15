# Notes module triage model — when triage runs, what it decides, how it fails

**Status**: accepted

The Notes module (map [#55](https://github.com/bsim0927/ben-os/issues/55)) captures a phone message
into Supabase, then an agent **triages** it: picks the notepad it belongs in (creating one if none
fits) and infers its structure. ADR 0010 fixed the _storage_ those reads and writes touch and
deliberately left the triage _behaviour_ — timing, failure handling, override reconciliation, the
tool contract — to this ADR (0012), resolving ticket
[#60](https://github.com/bsim0927/ben-os/issues/60). The cost/infra ground was surveyed in research
[#57](https://github.com/bsim0927/ben-os/issues/57): triage is the project's **first** LLM
integration; the only runtime is Vercel Cron → Next.js Node route handler (no Supabase edge
functions); **Vercel Hobby caps cron at one run/day**; and at personal scale the per-call cost is a
rounding error — so every choice below is a **freshness + infra-fit** call, not a price one.

## Decisions

1. **Triage runs on-arrival, with a once-daily cron _sweep_ as a backstop — not a scheduled batch.**
   A pure batched pass is dominated: the Hobby one-run/day cap makes it both up-to-24h stale _and_
   un-speed-uppable. So the primary path is **on-arrival** — a captured note triggers its own triage,
   giving the "fire from my phone → it's filed seconds later" feel and sidestepping the cron cap
   entirely (the trigger is a note write, not a cron). The daily cron is _not_ the workhorse: it is a
   **sweep** that re-picks any note still stuck untriaged (a failed on-arrival call, or a note captured
   while triage was down). One run/day is plenty for a backstop, so it fits inside the Hobby cap.
   Rejected: pure on-arrival (a stranded note has nothing to retry it); pure batched (stale + capped).

2. **Capture and triage are decoupled: the raw note lands and is acknowledged first, triage runs
   after.** A Telegram webhook redelivers if the handler doesn't `200` quickly, and a Haiku call is
   ~1–3s — long enough to risk a redelivery or timeout if triage ran inline before responding. So the
   ingest path **writes the raw note, responds `200` immediately, then runs triage** over the persisted
   row. Capture is therefore never blocked or lost by a slow or failing LLM call — matching ADR 0010's
   "the row lands first, an agent files it after." A consequence worth naming: the on-arrival trigger
   and the cron sweep become the **same** operation — _triage an already-landed untriaged note_ —
   differing only in what fires them. The ingest boundary itself is fixed by
   [ADR 0011](0011-notes-ingest-boundary.md) (ticket #59): its Ingest core lands a durable
   `triaged_at IS NULL` row and hands off _there_, deliberately not running triage inline — so this ADR
   builds directly on that seam. The exact async-invocation plumbing (post-response continuation vs. an
   internal trigger) that turns "row landed" into "on-arrival triage fired" is the one detail left to
   the build phase; this ADR only fixes that triage reads a _persisted_ note, never an in-flight request.

3. **Triage runs once per note, then the note is frozen against automatic re-triage.** A note is
   auto-triaged only while `triaged_at IS NULL`; a successful run sets `triaged_at` and the note is
   never auto-re-triaged. This makes manual overrides in the web manager permanent **by construction**:
   if you move a note to another notepad, no later automatic pass can undo it, because nothing
   re-triages a note that has already run. There is no reconciliation logic to get wrong — the conflict
   cannot arise. Re-triage exists only as an **explicit, user-initiated** action ("re-triage this
   note"), which deliberately re-arms the note (see decision 5). Rejected: routinely re-triageable
   notes, which would need rules to detect and respect manual moves.

4. **`triaged_at` means triage _ran_; `notepad_id` means it got _filed_. They are orthogonal, and
   "leave unfiled" is a legitimate triage outcome.** Because triage may create a notepad when none
   fits (decision 6), it never _has_ to abstain on placement — but forcing a home for every vague
   one-off note ("remember to think about this") would breed notepad sprawl. So triage may
   **deliberately leave a note unfiled**: file nowhere, yet still set `triaged_at` because it _ran and
   decided_. This keeps the two axes clean and matches ADR 0010's exact wording ("`triaged_at`
   disambiguates never-triaged/failed from triage-has-run"):
   - **Filed**: `notepad_id` set, `triaged_at` set.
   - **Deliberately unfiled**: `notepad_id` NULL, `triaged_at` set — sits in the inbox, but triage
     chose it, so the sweep leaves it alone.
   - **Pending / transient failure**: `triaged_at` NULL, attempts below the ceiling — the sweep retries.
   - **Permanently failed**: `triaged_at` NULL, attempts at the ceiling — visible in the inbox, the
     sweep skips it (decision 5).

   The model's placement priority is **reuse an existing notepad > create a new one > leave unfiled**,
   abstaining only when a note belongs nowhere.

5. **Retries are bounded and remembered on a `triage jsonb`; exhaustion is a visible dead-end, not a
   silent loop.** The note carries `notes_note.triage jsonb not null default '{}'` holding at least
   `{ model, attempts, last_error }` — bare `triaged_at` cannot express "failed 3× with error X," and
   a growing lifecycle field is exactly where this project prefers jsonb over typed columns
   (design-for-expansion; ADR 0010 decision 2). The sweep's takeable set is
   `triaged_at IS NULL AND coalesce((triage->>'attempts')::int, 0) < 3`: each attempt increments
   `triage.attempts` and, on error, records `triage.last_error`. At **3** failed attempts the note is
   _permanently failed_ — still `triaged_at IS NULL` and `notepad_id NULL` so it sits **visibly** in
   the inbox for manual attention, but the sweep no longer re-picks it. This keeps `triaged_at`
   semantics pure ("NULL always means not-yet-successfully-run") without an endless retry churn. A
   manual **re-triage** (decision 3) resets `triage.attempts` to 0, re-arming the note for one more
   pass. Three is enough to ride out a transient API blip without hammering a genuinely un-triageable
   note.

6. **Triage decides notepad + structure + a light body in one strict `file_note` tool call, on
   `claude-haiku-4-5`.** Per research #57, the call uses `@anthropic-ai/sdk` **tool use** — a single
   strict tool the model must call, cheapest/fastest model first. The tool's input the model sees is
   the note's `raw_text` plus the current notepad set (`id` + `name` + `kind` + `description`) as its
   choose-from list. The tool's parameters the model returns:

   | field         | type                                  | meaning                                              |
   | ------------- | ------------------------------------- | ---------------------------------------------------- |
   | `notepad_id`  | `string \| null`                      | an **existing** notepad's id to file into, else null |
   | `new_notepad` | `{ name, kind, description } \| null` | a notepad to create and file into                    |
   | `structure`   | `object`                              | the per-note `structure` jsonb (`done`, `due_at`, …) |
   | `body`        | `string`                              | conservatively cleaned working text                  |

   Rules enforced **server-side**, not trusted to the model:
   - **At most one** of `notepad_id` / `new_notepad` is non-null. Both null = deliberately unfiled
     (decision 4).
   - On `new_notepad`, the server **upserts by normalized name** (`lower(trim(name))`) so a create
     races safely against ADR 0010's unique index — if the notepad already exists, it is reused rather
     than erroring. The LLM is _prompted_ to prefer reuse, but the DB is the backstop.
   - `body` cleanup is **conservative**: strip routing preamble only (e.g. "add to groceries: mangoes"
     → "mangoes"), never reword the user's content. `raw_text` is untouched (ADR 0010 decision 6), so
     an over-eager clean is always recoverable.

   Two mutually-exclusive fields express existing-vs-new more legibly to the model than an overloaded
   "id-or-name" union. Fall back to `claude-sonnet-5` only if Haiku's placement quality proves poor.

## What triage writes

On a successful run triage sets, on the `notes_note` row: `notepad_id` (or leaves it null when
deliberately unfiled), `body` (cleaned), `structure`, `triaged_at = now()`, and merges
`{ model, attempts }` into `triage`. On a failed run it increments `triage.attempts`, sets
`triage.last_error`, and leaves `triaged_at` NULL for the sweep.

## Schema delta from ADR 0010

One additive column, in the design-for-expansion spirit ADR 0010 anticipated ("the fuller triage
lifecycle … can land as a `triage jsonb` when that ticket resolves"):

```sql
alter table public.notes_note
  add column triage jsonb not null default '{}'::jsonb;   -- { model, attempts, last_error } (decision 5)

-- the sweep's takeable set (decision 5); a partial index keeps it cheap as the table grows
create index notes_note_untriaged_idx
  on public.notes_note (created_at)
  where triaged_at is null;
```

Everything else triage needs already exists on the ADR 0010 schema (`notepad_id`, `body`,
`structure`, `triaged_at`, and the notepad `name`/`kind`/`description` it reads). This delta folds
into the eventual `notes_schema` migration; like the rest of that migration, the destructive-guard
triggers mean it is applied out-of-band at build time rather than through the Supabase MCP server.

## Consequences

- The **ingest boundary** ([ADR 0011](0011-notes-ingest-boundary.md), ticket #59) already lands a
  durable untriaged row and stops; this ADR is the downstream half — triage is an idempotent operation
  over that persisted, untriaged note. The build phase owns the exact async trigger that fires it.
- The **capture feedback loop** ([#69](https://github.com/bsim0927/ben-os/issues/69)) is unblocked:
  because triage runs seconds after capture, a
  bot reply like "Added to Shopping list ✓" is feasible on the on-arrival path, and a reply that
  corrects placement maps onto the explicit re-triage action (decision 3).
- The **web manager** ([#62](https://github.com/bsim0927/ben-os/issues/62)) surfaces the inbox
  (`notepad_id IS NULL`), which now mixes deliberately-unfiled, pending, and permanently-failed notes —
  distinguishable by `triaged_at` and `triage.attempts` — and offers the manual **re-triage** action.
- **Notepad sprawl** is bounded by the reuse-first prompt, the normalized-name upsert, and the
  leave-unfiled escape hatch (decisions 4, 6) — not by any hard cap.
- **Concurrency**: on-arrival and the sweep could in principle both pick the same note. At personal
  scale this is negligible; if it ever bites, the claim is a conditional update
  (`… where triaged_at is null`) so only one writer wins.

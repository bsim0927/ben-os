# Notes module — build spec

**Status**: build-ready · composed from wayfinder map
[#55](https://github.com/bsim0927/ben-os/issues/55), ticket
[#63](https://github.com/bsim0927/ben-os/issues/63).

This spec is a **composition, not a fresh set of decisions**. The map made every decision below in its
own ticket and recorded the rationale in an ADR; this document assembles them into one coherent,
build-ready picture and hands it to `/to-tickets`. Each build area cites the ADR that owns its detail —
go there for the _why_ and the rejected alternatives; this spec fixes the _what_ and _where_. Where an
ADR deliberately left a knob to the build phase, it is flagged **[build-time]** here, not re-decided.

The map's rule was **plan, don't do** — so nothing below has been built. This is the plan the build
executes against.

## What we're building

The Notes module (`/notes`, already registered `status: "soon"` in `apps/web/lib/modules.ts`): fire a
message from your phone, it lands in Supabase, an agent triages it into the right **notepad** — creating
one if none fits — and the bot replies telling you where it went, one tap from a correction. A full web
**manager** renders the notepads and lets you check items off, move notes, create / rename / merge /
delete notepads, and override the agent.

The pipeline, end to end:

```
 Telegram          per-channel                 shared           row lands            on-arrival
 webhook  ──────▶  Adapter        ──────▶  Ingest core  ──────▶  (triaged_at    ──────▶  Triage
 (message)         (auth, parse,            (validate,           IS NULL)               (file_note
                    normalize)               dedup, insert)                             LLM tool call)
                                                                                            │
      ▲                                                                                     ▼
      │  callback_query (button tap)                                             notifyCapture(outcome)
      │                                                                                     │
 Correction op  ◀───── same webhook route, branches on update type              Outbound adapter (Telegram)
 (reassign notepad_id)                                                          "📓 Filed in *X* ✓  [✏️ Move]"

 Web manager (Variant B, Library) reads/writes the same notes_notepad + notes_note tables directly.
```

Every stage is **channel-agnostic** at its boundary: Telegram is adapter #1 inbound _and_ outbound; a
future iOS widget slots in as one more adapter each way, no core or triage change.

## Conventions this module follows

- A module under `apps/web/app/(modules)/notes/`, mirroring `financials/`. Shared shell reused as-is:
  `components/crumb-row.tsx`, `components/module-sidebar.tsx`, `components/console.tsx`, and the
  `(modules)/layout.tsx` chrome — the Console visual identity.
- Server logic under `apps/web/lib/notes/`, mirroring `apps/web/lib/financials/`.
- Prefix-namespaced Supabase tables (`notes_*`) on the ADR 0001 baseline (see build area A).
- New domain terms already live in `CONTEXT.md` (Notepad, Note, Structure, Unfiled, Channel, Adapter,
  Ingest core, Triage, Triage sweep, Capture confirmation, Correction, Outbound adapter). No new
  vocabulary is introduced by the build; use those names.
- Flip `modules.ts` `notes` from `status: "soon"` to live once the page ships.

## Build areas

Slice these into tickets. They have a natural dependency order (A → B → {C, D} → E, F); C/D/E share the
schema and DB writer, F is independent of the capture pipeline once the schema exists.

### A. Schema & migration — `notes_notepad` + `notes_note`

**Owner ADR:** [0010](../adr/0010-notes-data-model.md) (data model) + [0012](../adr/0012-notes-triage-model.md)
schema delta.

Two tables on the ADR 0001 baseline (`id uuid` pk, `created_at`/`updated_at` + shared `set_updated_at()`
trigger, one `FOR ALL USING (is_authorized()) WITH CHECK (is_authorized())` RLS policy, hard delete, the
`notes_` prefix, and the truncate/drop/bulk-delete destructive guards the `financials_*` tables carry).

- `notes_notepad`: `name`, `kind` (default `'freeform'`), `description` (nullable); unique index on
  `lower(trim(name))` (ADR 0010 dec. 3).
- `notes_note`: `notepad_id` (nullable FK — null = unfiled/inbox), `raw_text` (immutable), `body`
  (editable, starts `= raw_text`), `structure jsonb`, `channel`, `source jsonb`, `captured_at`,
  `triaged_at` (nullable), **`triage jsonb`** (ADR 0012 dec. 5 — `{ model, attempts, last_error }`).
- Indexes: partial unique `(channel, (source->>'external_id')) WHERE source->>'external_id' IS NOT NULL`
  (capture idempotency, ADR 0010 dec. 8); partial `(created_at) WHERE triaged_at IS NULL` (the sweep's
  takeable set, ADR 0012 dec. 5).

Full DDL sketch is in ADR 0010's "Schema sketch" plus ADR 0012's "Schema delta"; fold both into one
`notes_schema` migration.

> **[build-time] Applied out-of-band.** A new-table migration that installs the destructive-guard
> triggers **cannot** be applied through the Supabase MCP server — the SQL guard blocks the guard
> triggers themselves (see the map's Notes and the SQL-guard convention in `CLAUDE.md`). This migration
> is applied out-of-band at build time; the builder should surface it to Ben rather than routing around
> the guard.

### B. Authorized DB writer — `lib/notes/db.ts`

**Owner ADR:** [0011](../adr/0011-notes-ingest-boundary.md) dec. 4.

A `withAuthorizedSession` writer modeled directly on `apps/web/lib/financials/db.ts`: connect via
`DATABASE_URL`, and inside each transaction assume the `authenticated` role with the authorized user's
JWT claims (`set_config('request.jwt.claims', …)` + `set local role authenticated`) so `is_authorized()`
RLS is evaluated even for server-originated writes. **No service-role client** — ben-os has none by
design (`apps/web/.env.example` warns against substituting one). Every server-side Notes write (ingest,
triage, correction) goes through this one writer, so `is_authorized()` is the single gate on every path,
web and phone alike.

### C. Ingest boundary — core + Telegram inbound adapter + webhook route

**Owner ADR:** [0011](../adr/0011-notes-ingest-boundary.md).

- **`ingestNote(normalized)` core** (`lib/notes/`): validates the normalized quartet, dedups via
  `insert … on conflict do nothing` on the idempotency index, derives `body := raw_text`,
  `notepad_id := null`, `triaged_at := null`, and inserts through the area-B writer. Returns a
  landed / deduped / failed outcome. **Never runs triage** — a `triaged_at IS NULL` row is the entire
  hand-off (dec. 3).
- **Normalized inbound shape** (the adapter's whole output): `{ raw_text, channel, source, captured_at }`
  (dec. 2). Telegram mapping: `raw_text := message.text`, `channel := 'telegram'`,
  `source := { external_id: String(update_id), chat_id, message_id }`,
  `captured_at := new Date(message.date * 1000)`.
- **Telegram adapter + route** at `/api/notes/telegram/webhook`: authenticates with the
  `X-Telegram-Bot-Api-Secret-Token` header **and** the hard-coded `TELEGRAM_ALLOWED_CHAT_ID` allowlist
  (chat `5694272797`), then maps native payload → normalized → core (dec. 4). HTTP responses per dec. 5:
  401 (bad/missing secret) · 200+drop (sender not allowlisted) · 200 (duplicate `update_id`, no-op) ·
  200 (new note landed) · 500 (genuine failure, let Telegram retry).

The bot itself is already provisioned (ticket [#61](https://github.com/bsim0927/ben-os/issues/61),
PR #65): `@BensNoteBot`, with `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_ID` in `.env.local`, Vercel
production, and documented in `.env.example`. The build sets the webhook (`setWebhook` with the secret
token) against this route.

### D. Triage — on-arrival + daily sweep, `file_note` tool call

**Owner ADR:** [0012](../adr/0012-notes-triage-model.md).

- **One idempotent operation** — _triage an already-landed untriaged note_ — fired two ways (dec. 1–2):
  - **On-arrival**: a captured note triggers its own triage over the _persisted_ row (never inline in
    the webhook — capture `200`s first). **[build-time]** the exact async plumbing that turns "row
    landed" into "on-arrival triage fired" (post-response continuation vs. an internal trigger) is the
    one detail ADR 0012 left to the build.
  - **Daily cron sweep** (Vercel Cron → Next.js Node route handler): re-picks the stuck tail
    `triaged_at IS NULL AND coalesce((triage->>'attempts')::int, 0) < 3`. It is a **backstop**, not the
    workhorse — one run/day fits Vercel Hobby's cron cap.
- **`file_note` tool call** on `claude-haiku-4-5` via `@anthropic-ai/sdk` **tool use** (dec. 6). Model
  sees `raw_text` + the notepad set (`id`/`name`/`kind`/`description`); returns `notepad_id | null`,
  `new_notepad {name,kind,description} | null`, `structure`, `body`. **Server-enforced** (not trusted to
  the model): at most one of `notepad_id`/`new_notepad` non-null (both null = deliberately unfiled);
  `new_notepad` upserts by `lower(trim(name))`; `body` cleanup strips routing preamble only, never
  rewords, `raw_text` untouched. Fall back to `claude-sonnet-5` only if Haiku placement quality proves
  poor. This is ben-os's **first** LLM integration — establish `lib/notes/` as where the `@anthropic-ai/sdk`
  client and `ANTHROPIC_API_KEY` land.
- **Lifecycle** (dec. 3–5): triage once, then frozen against automatic re-triage (manual moves permanent
  by construction). Outcomes on the orthogonal `triaged_at` × `notepad_id` axes — **filed** / **deliberately
  unfiled** (both `triaged_at` set) / **pending** / **permanently failed** (both `triaged_at IS NULL`,
  attempts `<3` vs `=3`). Bounded retries (ceiling 3) recorded on `triage jsonb`; exhaustion is a visible
  inbox dead-end, not a silent loop. Re-triage is explicit and user-initiated only (resets
  `triage.attempts`).
- **Concurrency:** the claim is a conditional update (`… where triaged_at is null`) so on-arrival and the
  sweep can't both file the same note.

### E. Capture feedback — confirmation, outbound adapter, correction

**Owner ADR:** [0013](../adr/0013-notes-capture-feedback-loop.md).

- **One confirmation reply, after triage, from the triage step** (dec. 1–2) — never from the ingest core
  (which stops at the landed row). No pre-triage ack on the happy path.
- **`notifyCapture(note, outcome)` dispatcher + Telegram Outbound adapter** (dec. 3): triage emits a
  channel-agnostic `{ notepad, created?, unfiled?, failed? }`; the dispatcher selects the Outbound
  adapter by `note.channel`; the Telegram one renders the text + inline keyboard and calls `sendMessage`.
  **Triage never imports Telegram.** The confirmation set (dec. table):
  - Filed (existing): `📓 Filed in *Shopping list* ✓`
  - Filed (new notepad): `🆕 Started *Shopping list* and filed it ✓`
  - Deliberately unfiled: `📥 Kept in your inbox — nothing fit`
  - Failed/stuck: `⚠️ Saved, but I couldn't file it — place it?`
  - Every reply carries a `[✏️ Move]` button — any outcome, failure included, is one tap from correction.
- **Correction — deterministic manual picker, no LLM** (dec. 4–6): `✏️ Move` expands to a button per
  existing notepad + `➕ New notepad`; a tap reassigns `notepad_id` **directly**. `➕ New notepad` prompts
  "Name it?", creates a `kind = freeform` notepad via the same normalized-name upsert, files the note.
  The bot picker is **manual-only** — no "let the agent retry" (model re-triage is web-manager-only).
- **`callback_query` branch in the same webhook route** (dec. 6): the Telegram adapter authenticates a
  tap identically (secret header + allowlist), then **branches on update type** — a `message` → the
  `ingestNote()` core (new capture); a `callback_query` → a distinct **correction op** that sets
  `notepad_id` on the **existing** row (or creates-then-files). The correction op is _not_ `ingestNote`;
  it writes through the same area-B `lib/notes/db.ts` writer. Note identity rides in the callback data
  (the note id), not reply-threading. After the write: `answerCallbackQuery` + edit the confirmation
  message to show the new placement.

### F. Web manager — Variant B (Library)

**Owner:** prototype ticket [#62](https://github.com/bsim0927/ben-os/issues/62) (Ben picked Variant B);
interaction invariants fixed by [ADR 0010](../adr/0010-notes-data-model.md). Primary source: the full
prototype on branch `worktree-ticket-62-notes-ui-prototype` →
`apps/web/app/(modules)/notes/notes-manager.prototype.html` (throwaway) — build to **Variant B only**.

Page at `apps/web/app/(modules)/notes/page.tsx`, two-column grid inside the module shell (crumb row
`Notes / Manager`, sync chip):

- **Left rail** — `Inbox` pinned at top (accent dot), a hairline, then notepads in name order as
  `• name … count` rows; a freshly agent-created notepad carries a `new` badge for its first hour;
  `+ New notepad` at the foot. Selecting a row swaps the detail pane; selection is the only rail state.
- **Detail pane** — header: notepad name (inline-editable) + `kind` chip + (if fresh) `new` badge;
  description subtitle (muted "add one to steer triage" when absent); notepad `⋯` menu
  (rename / change kind / **merge into…** / delete). Body: an `add a note…` inline field, then a dense
  hairline-separated note list.
- **Inbox view** — same pane, no add-field, header `Inbox / unfiled`; empty state "Inbox zero —
  everything has been triaged." Surfaces the mixed unfiled set (deliberately-unfiled / pending /
  permanently-failed, distinguishable by `triaged_at` + `triage.attempts`) and offers the manual
  **re-triage** action (ADR 0012's web-only re-arm).

Interaction invariants (fixed by ADR 0010, layout-independent):

- **Checklist rendering** off `notepad.kind` + per-note `structure`: a checkbox renders iff the note has
  a `structure.done` key; toggle flips it; done → strikethrough + muted. `structure.due_at` shows as a
  mono chip (overdue `--negative`, ≤3d `--accent`).
- **Inbox is the `notepad_id IS NULL` query** — a pinned rail item, not a row; nothing special-cases an
  Inbox notepad. "Unfile" is a real move target.
- **Move** = reassign `notepad_id` + stamp `triaged_at = now`, from a note's `⋯` menu.
- **Merge** = reassign every note's `notepad_id` to the target, then delete the emptied notepad
  (ADR 0010 dec. 3), from a notepad's `⋯` menu.
- **Agent-override correction:** an agent-filed note shows an `agent → <notepad>` chip; moving it flips
  the chip to **"you filed this"** and sets a manual-override flag — the hook the _re-triage &
  manual-override reconciliation_ fog item needs later.
- **`show original`** reveals `raw_text` only when it differs from `body` (ADR 0010 dec. 6).
- **Create notepad** enforces the `unique lower(trim(name))` backstop (duplicate rejected with a
  message); **rename** / **change kind** are inline; **delete note** is immediate (hard delete, ADR 0001).
- **[build-time] Delete a non-empty notepad → orphan its notes to Inbox** (`notepad_id IS NULL`,
  re-triageable), not block-until-empty; merge stays the lossless path. A confirm step at build time is
  fine (the prototype's resolved default).

## v1 non-goals — explicitly excluded

These were named on the map as fog or out-of-scope. They are **not** part of this build; the design keeps
the door open for each without building it. Do not let them creep into the tickets.

- **Media notes** (photos / voice memos) — text-first v1 only. The ingest boundary and confirmation
  already accommodate a media adapter (`file_id`→`getFile` per #56, `raw_text` = caption/transcript), but
  v1 builds none of it. (map fog)
- **Notepad lifecycle / archiving** — when a notepad goes stale or gets archived is unspecified; if it
  arrives it's an additive column (`archived_at` / `status`), not a v1 concern. (map fog)
- **iOS widget capture channel** — a later effort. The channel-agnostic inbound Adapter and Outbound
  adapter are the seams it will slot into; the widget itself is not built here. (map out-of-scope)
- **Cross-module wiring** — surfacing note `due_at` in Calendar, or note-from-email, belongs to those
  modules' own efforts. (map out-of-scope)

## Decision provenance

Every build area above is a composition of a settled decision; go to the source for rationale and
rejected alternatives.

| Concern                        | Ticket                                              | Source                                                 |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------ |
| Telegram Bot API capture facts | [#56](https://github.com/bsim0927/ben-os/issues/56) | research (webhook, secret token, allowlist)            |
| LLM runtime & cost facts       | [#57](https://github.com/bsim0927/ben-os/issues/57) | research (Vercel Cron, Hobby cap, `@anthropic-ai/sdk`) |
| Data model                     | [#58](https://github.com/bsim0927/ben-os/issues/58) | [ADR 0010](../adr/0010-notes-data-model.md)            |
| Ingest boundary                | [#59](https://github.com/bsim0927/ben-os/issues/59) | [ADR 0011](../adr/0011-notes-ingest-boundary.md)       |
| Triage model                   | [#60](https://github.com/bsim0927/ben-os/issues/60) | [ADR 0012](../adr/0012-notes-triage-model.md)          |
| Bot provisioning               | [#61](https://github.com/bsim0927/ben-os/issues/61) | env vars (PR #65)                                      |
| Web manager UI                 | [#62](https://github.com/bsim0927/ben-os/issues/62) | prototype, Variant B (Library)                         |
| Capture feedback loop          | [#69](https://github.com/bsim0927/ben-os/issues/69) | [ADR 0013](../adr/0013-notes-capture-feedback-loop.md) |

Map: [#55](https://github.com/bsim0927/ben-os/issues/55). This spec resolves the terminal composition
ticket [#63](https://github.com/bsim0927/ben-os/issues/63) — with it, the way from a loose idea to a
buildable Notes module is clear, and the map is complete.

# Notes module ingest boundary — the channel-agnostic capture contract

**Status**: accepted

The Notes module (map [#55](https://github.com/bsim0927/ben-os/issues/55)) captures a message from a
phone channel and lands it in Supabase, where triage later files it into a notepad. ADR
[0010](docs/adr/0010-notes-data-model.md) fixed the **storage shape** a captured note lands in. This
ADR (0011) fixes the **path a raw note takes to become that row** — the ingest boundary — resolving
ticket [#59](https://github.com/bsim0927/ben-os/issues/59). Telegram (provisioned in
[#61](https://github.com/bsim0927/ben-os/issues/61)) is adapter #1; the goal is that a future iOS
widget slots in without a rewrite. This ADR is plan-only, like 0010 — no code is written by it.

## Decisions

1. **Two roles: a per-channel _Adapter_ and one shared _Ingest core_.** A channel never posts a
   "normalized note" — Telegram POSTs its own webhook shape to a URL — so there is necessarily a
   per-channel **Adapter** that receives the native payload at its own route
   (`/api/notes/telegram/webhook` for v1), authenticates it, and maps it to the normalized inbound
   shape. Every adapter then calls **one in-process `ingestNote()` core** that validates, dedups, and
   inserts the row. Adding a channel is a new adapter, not a new copy of the insert logic.
   Rejected: **per-channel handlers writing to the DB directly** (repeats validate/dedup/insert per
   channel — the invariants drift), and **a public generic HTTP ingest endpoint** (turns the
   note-insert into a public attack surface needing its own auth scheme, for no gain at personal
   scale).

2. **The normalized inbound shape is exactly ADR 0010's provenance quartet.** An adapter's whole
   output is:

   ```
   {
     raw_text:    string,   // the message text, verbatim — becomes notes_note.raw_text
     channel:     string,   // 'telegram' for v1 — the discriminator
     source:      object,   // channel-specific ids, incl. a stable source.external_id
     captured_at: string,   // the sender's timestamp (ISO), NOT row-insert time
   }
   ```

   For Telegram: `raw_text := message.text`, `channel := 'telegram'`,
   `source := { external_id: String(update_id), chat_id, message_id }`,
   `captured_at := new Date(message.date * 1000)`. `source.external_id` is the Telegram `update_id`
   — the stable key ADR 0010 decision 8 dedups on. The core, not the adapter, then derives the rest:
   `body := raw_text`, `notepad_id := null`, `triaged_at := null`.

3. **Ingest is decoupled from triage; the hand-off is one row state.** The ingest core's
   responsibility ends at a durably-landed row with `triaged_at IS NULL`. It never calls triage
   synchronously. **An untriaged note is any `notes_note` with `triaged_at IS NULL`** — that query
   _is_ the entire seam to triage. Whether triage runs on-arrival, on a cron, or on-demand is
   [#60](https://github.com/bsim0927/ben-os/issues/60)'s decision alone, which this boundary must not
   presuppose. Rejected: **inline triage** (normalize → triage → file in one request) — it would
   pre-empt #60, and running an LLM inside the webhook would blow the fast-`200` budget below and
   trigger Telegram redelivery storms.

4. **Auth is per-channel, enforced in the Adapter; the core inserts via the service role.** A webhook
   has **no Supabase user session** — Telegram posts server-to-server — so `is_authorized()` (the RLS
   gate for _Ben's web session_) cannot be the ingest mechanism. Each adapter authenticates its own
   channel and then calls the trusted in-process core, which inserts with the **service role**,
   bypassing RLS. `is_authorized()` stays the gate for the **web manager** reading and editing notes,
   never for ingest. A future iOS widget brings its own adapter-level auth (a shared secret / signed
   token) — same pattern, different check. For Telegram specifically (per
   [#56](https://github.com/bsim0927/ben-os/issues/56)): the `X-Telegram-Bot-Api-Secret-Token` header
   proves the caller is Telegram, and the hard-coded `TELEGRAM_ALLOWED_CHAT_ID` allowlist
   (chat `5694272797`) proves the sender is Ben.

5. **Response behavior is idempotent-and-fast, tuned to how Telegram retries.** Telegram redelivers
   an update unless the handler returns `2xx` quickly, so the adapter's HTTP responses are chosen to
   make redelivery safe and to not invite it from bad senders:

   | Case                                | Response       | Why                                                                 |
   | ----------------------------------- | -------------- | ------------------------------------------------------------------- |
   | Secret-token header missing/wrong   | **401**        | Not even Telegram — reject outright.                                |
   | Sender not in the chat-id allowlist | **200 + drop** | Don't leak existence, don't invite retries; silently ignore.        |
   | Duplicate `update_id`               | **200**        | `insert … on conflict do nothing` on the idempotency index → no-op. |
   | Valid, new note landed              | **200**        | Row is durable; triage will pick it up.                             |
   | Genuine insert / infra failure      | **500**        | Let Telegram retry — the note isn't safely stored yet.              |

   The core returns a landed / deduped / failed outcome; mapping that to the HTTP status is the
   adapter's job (a non-Telegram adapter maps the same outcomes to its own transport).

## Consequences

- The build spec ([#63](https://github.com/bsim0927/ben-os/issues/63)) implements one
  `ingestNote(normalized)` core plus a Telegram adapter route; a service-role Supabase client is
  needed server-side for the core's insert (distinct from the RLS-scoped client the web manager uses).
- Triage ([#60](https://github.com/bsim0927/ben-os/issues/60)) is free to choose its trigger: it reads
  `triaged_at IS NULL` notes and writes `notepad_id` / `body` / `structure` / `triaged_at`. Nothing in
  ingest constrains that choice.
- The capture feedback loop (fog: does the bot reply "Added to Shopping list ✓") is a _reply from the
  adapter_, and depends on triage having run — it stays fog under #60, not this ADR.
- Media notes (photos / voice) are a later increment: an adapter would resolve `file_id` → `getFile`
  (per #56) into `source`, with `raw_text` a caption or transcript. The boundary shape already
  accommodates it; text-first v1 does not build it.
- A new channel = a new adapter implementing its own auth + payload mapping to the normalized shape,
  then calling the unchanged core. No schema or core change. This is the "slots in without a rewrite"
  property the map required.

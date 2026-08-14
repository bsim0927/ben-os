# Notes module ingest boundary — the contract a raw note crosses to land in the DB

**Status**: accepted

The Notes module (map [#55](https://github.com/bsim0927/ben-os/issues/55)) captures a message from a
phone channel — Telegram for v1, an iOS widget later — and lands it in Supabase for triage. This ADR
(0011) fixes **where and how a raw inbound note crosses into the system**, resolving ticket
[#59](https://github.com/bsim0927/ben-os/issues/59). It builds on the storage shape from
[ADR 0010](0010-notes-data-model.md) (which fixed the row) and the Telegram research
([#56](https://github.com/bsim0927/ben-os/issues/56)); it deliberately does **not** decide the triage
model, which stays [#60](https://github.com/bsim0927/ben-os/issues/60)'s to design.

The whole point of the boundary is that **Telegram is adapter #1**, and a future channel slots in
without a rewrite.

## Decisions

1. **The boundary is an internal function, `ingestNote(RawNote)`, not one shared HTTP endpoint.**
   Telegram does not POST our shape — it POSTs its own `Update` JSON, with its own header auth, on a
   format Telegram controls, not us. An iOS widget later would be our own client, free to send whatever
   we design. So "one URL everyone posts to" cannot literally hold. Instead the channel-agnostic seam
   is a **function**: `ingestNote(raw: RawNote)` does the DB write, and each channel gets a **thin HTTP
   adapter** that parses its native format, authenticates, normalizes to `RawNote`, and calls the
   function. Telegram is the first adapter; the widget later is a second adapter over the same function.
   Rejected: a single generic HTTP endpoint that channels pre-normalize to — impossible for Telegram,
   which will only ever send its own shape.

2. **`RawNote` is the normalized contract, dictated by ADR 0010's row.** An adapter hands the function:

   ```ts
   type RawNote = {
     raw_text: string; // exactly what arrived, verbatim
     channel: string; // 'telegram' (v1); the discriminator
     source: {
       // channel-specific identifiers (jsonb)
       external_id: string; // stable dedup key — Telegram: the update_id
       [k: string]: unknown;
     };
     captured_at: string; // sender's timestamp (Telegram date, Unix seconds → ISO)
   };
   ```

   `ingestNote` writes the `notes_note` row from this: it copies `raw_text` into `body` (the editable
   working copy starts equal to the pristine original), and leaves the note **unfiled and untriaged** —
   `structure = {}`, `notepad_id = NULL`, `triaged_at = NULL`. Everything triage owns is left untouched.

3. **Ingest ends at a durable, idempotent, unfiled insert; triage is downstream and decoupled.**
   The boundary's job finishes the moment the note has landed as an unfiled row — it says nothing about
   _when_ or _how_ triage runs. Two reasons this line, not an inline one. (a) Telegram redelivers the
   webhook if the handler doesn't `200` fast enough ([#56](https://github.com/bsim0927/ben-os/issues/56)),
   and running LLM triage inside the request is exactly the latency that triggers redelivery. (b) Inline
   triage would hard-wire [#60](https://github.com/bsim0927/ben-os/issues/60)'s answer into the boundary;
   leaving the note in a triageable state keeps on-arrival-trigger vs batched-poll both open for #60 to
   decide. Idempotency rides on ADR 0010's partial unique index on
   `(channel, source->>'external_id')`: a redelivery hits the conflict and is a **no-op that still
   returns `200`** — the adapter treats the unique-violation as success, never surfacing it as an error,
   so Telegram stops retrying.

4. **Auth is two checks, one RLS regime — and ingest does _not_ bypass RLS.**
   Channel authentication is channel-specific, so it lives **in the adapter**, not the shared function.
   The Telegram adapter verifies the `X-Telegram-Bot-Api-Secret-Token` header against the configured
   secret ("really Telegram?"), then compares `message.chat.id` against the single allowlisted id in
   `TELEGRAM_ALLOWED_CHAT_ID` ("really Ben?", chat id `5694272797` per #56) — a mismatch on either is
   dropped while **still returning `200`**, so Telegram does not retry a rejected message.

   The DB write then follows the **house rule this codebase already enforces for session-less server
   writers**: there is no service-role client, and `.env.example` explicitly warns "Do not substitute a
   service-role connection." The Financials cron writer (`apps/web/lib/financials/db.ts`,
   `withAuthorizedSession`) connects via `DATABASE_URL` and, inside each transaction, assumes the
   `authenticated` role with the authorized user's JWT claims
   (`set_config('request.jwt.claims', …)` + `set local role authenticated`), so `is_authorized()` RLS
   is evaluated even for the server-originated write. Notes ingest reuses this exactly — a
   `lib/notes/db.ts` analogue — so a Telegram-originated write passes the same RLS as a web write.
   There is **no privileged backdoor**: the adapter's channel gate and the DB's RLS are two independent
   checks, and RLS is never bypassed. `is_authorized()` remains the sole guard on the web-manager path
   too; ingest is not a special case that escapes it.

## Layout

Follows the established ben-os module conventions (confirmed against Financials):

- **Adapter (HTTP):** `apps/web/app/api/notes/telegram/route.ts` — a `POST` route handler, mirroring
  `app/api/financials/snaptrade/*`. It is the Telegram webhook target.
- **Boundary + write (server logic):** `apps/web/lib/notes/` — `ingest.ts` (the `ingestNote` function
  and `RawNote` type), `db.ts` (the `withAuthorizedSession` analogue), mirroring `lib/financials/`.
  Server data logic never lives in the module UI directory (`app/(modules)/notes/`).

## Consequences

- **Build tickets, not this map's, own the wiring.** `ingestNote` is the seam `/to-tickets` builds
  against: the Telegram adapter, the `lib/notes/db.ts` writer, and the `notes_schema` migration
  (ADR 0010, applied out-of-band because the guard triggers can't go through the MCP server).
- **A one-time `setWebhook` registration** is required to point Telegram at the deployed adapter URL
  (passing the `secret_token`); it needs a live URL, so it is a build/deploy step, not a decision — it
  belongs in the build phase, not as a wayfinder decision ticket.
- **Adding a channel is adding an adapter.** The iOS widget (out of scope for this map) becomes a
  second HTTP adapter that authenticates its own way and calls the same `ingestNote` — no change to the
  function, the contract, or the schema.
- **Triage ([#60](https://github.com/bsim0927/ben-os/issues/60)) inherits a clean starting state:** a
  stream of unfiled, untriaged notes with `raw_text` intact. It is free to trigger on-arrival or batch
  on a poll without the boundary having presupposed either.

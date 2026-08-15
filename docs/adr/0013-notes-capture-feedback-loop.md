# Notes module capture feedback loop — bot confirmation and correct-by-reply

**Status**: accepted

The Notes module (map [#55](https://github.com/bsim0927/ben-os/issues/55)) captures a phone message,
lands it in Supabase, and an agent triages it into a notepad. This ADR (0013) fixes what the capture
**channel tells you back** — whether the bot confirms where a note landed, and how you correct a
mis-file from the phone — resolving ticket
[#69](https://github.com/bsim0927/ben-os/issues/69). It builds directly on two accepted decisions it
must not re-open: the ingest boundary ([ADR 0011](0011-notes-ingest-boundary.md), ticket #59) makes
capture channel-agnostic through a per-channel **Adapter** and a shared **Ingest core** that lands a
durable `triaged_at IS NULL` row and stops; the triage model ([ADR 0012](0012-notes-triage-model.md),
ticket #60) runs triage **on-arrival** (seconds after capture, after a fast `200`), makes **manual
placement permanent by construction**, and keeps **re-triage an explicit, user-initiated** action.
Like 0010–0012 this ADR is **plan-only** — no code is written by it.

## Decisions

1. **The bot sends one confirmation reply, after triage runs, naming the notepad and flagging
   created-vs-reused.** The one thing you cannot see from your phone — and the thing most likely to be
   wrong — is _which notepad the note landed in and whether triage invented a new one_ (a notepad you
   didn't want created is how sprawl starts). So triage, on finishing, sends a single Telegram reply
   naming the notepad and whether it was **reused or newly started**. It is one message, not two:
   because triage is ~1–3s on the on-arrival path (ADR 0012 decision 1), a separate pre-triage "got
   it, filing…" acknowledgement would be noise, so there is **no** capture-ack before triage on the
   happy path. Rejected: **no reply** (you'd have to open the web manager to learn where anything
   went); a **bare emoji reaction** on your own message (lighter, but can't name the notepad, which is
   the whole point).

2. **The confirmation is sent by the triage step, not the Ingest core.** ADR 0011 deliberately stops
   the Ingest core at the landed `triaged_at IS NULL` row and forbids it from running triage inline.
   The confirmation depends on the triage _outcome_ (which notepad, created-vs-reused, unfiled,
   failed), which only exists once triage has run — so the reply necessarily lives **downstream in
   triage**, never in the core. This keeps ADR 0011's fast-`200` capture path untouched: capture still
   acknowledges to Telegram immediately with a bare `200`, and the human-facing confirmation is a
   _separate, later_ outbound message.

3. **The return path is a symmetric, channel-agnostic Outbound adapter — triage never imports
   Telegram.** ADR 0011 made _inbound_ channel-agnostic (`native payload → Adapter → normalized →
core`); the reply is its mirror, and the map's standing requirement is that a future iOS widget
   "slots in without a rewrite" — which has to hold on the **return** path too, or capture is
   channel-agnostic while the confirmation is hard-wired to Telegram. So triage produces a
   channel-agnostic **capture outcome** (`{ notepad, created?, unfiled?, failed? }`) and hands it to a
   `notifyCapture(note, outcome)` dispatcher that selects the Outbound adapter by `note.channel`. The
   Telegram outbound adapter renders the text plus the inline keyboard (decision 5) and calls
   `sendMessage`; a future iOS-widget adapter registers its own reply (a push, or a no-op). Rejected:
   **triage calls Telegram's `sendMessage` directly** — simpler today, but couples the triage/LLM
   layer to one channel and forces exactly the rewrite the map forbids when the widget arrives.

4. **Correction is a deterministic manual picker, not an LLM re-interpretation.** The whole purpose of
   correcting a filing is to _remove_ the model's judgment, so re-invoking an LLM to interpret a
   free-text correction ("no, this is groceries") is self-defeating — it re-introduces the guesswork
   you are overriding. Instead the confirmation carries an inline **`✏️ Move`** button; tapping it
   expands the message into a button per existing notepad plus **`➕ New notepad`**; tapping a notepad
   reassigns the note's `notepad_id` **directly**, no LLM involved. The bot picker is **manual-only**:
   it deliberately offers **no** "let the agent try again" option — model re-runs (ADR 0012's explicit
   re-triage) stay a **web-manager-only** action, where you're already looking at the inbox. The clean
   mental model: _the phone corrects by hand; the web manager can ask the agent to retry._ Rejected: a
   typed `redo` keyword whose free text an LLM parses (self-defeating, above); a typed-keyword picker
   without buttons (relies on Telegram reply-to threading to identify the note, which the user can
   forget to use, leaving the bot unable to tell which note is meant).

5. **`➕ New notepad` prompts for a name and defaults `kind = freeform`.** Tapping `➕ New notepad`
   makes the bot ask "Name it?"; the user's reply becomes the notepad name, and the note is filed into
   the freshly-created notepad. The notepad is created with **`kind = freeform`** — the phone flow does
   not ask about kind (checklist/list/…); freeform is the safe default and the kind is adjustable later
   in the web manager. The create goes through the same normalized-name upsert triage uses (ADR 0012
   decision 6), so a correction that races an existing name reuses rather than duplicates.

6. **Button-taps come back through the same webhook and are their own operation, never `ingestNote`.**
   A tap fires a Telegram **`callback_query`** update, which Telegram POSTs to the _same_
   `/api/notes/telegram/webhook` route as messages. The Telegram Adapter authenticates it identically
   — `X-Telegram-Bot-Api-Secret-Token` header **and** the hard-coded `TELEGRAM_ALLOWED_CHAT_ID`
   allowlist (ADR 0011 decision 4) — then **branches on update type**: a `message` goes to the
   `ingestNote()` core (a new capture), a `callback_query` goes to a distinct **correction op** that
   sets `notepad_id` on the **existing** row (or creates-then-files for `➕ New notepad`). The
   correction op is _not_ `ingestNote`: ingest exists only to land new captures with idempotency, while
   a correction mutates a row that already exists. The correction write goes through the **same**
   `lib/notes/db.ts` writer the ingest core uses, so it passes the identical `is_authorized()` gate on
   the way in. Note identity rides in the **callback data** (the note id the button was built with),
   not reply-threading — so the bot always knows exactly which note is being corrected. After the
   write, the adapter `answerCallbackQuery`s and edits the confirmation message to show the new
   placement.

## The confirmation set

Every confirmation carries the `✏️ Move` button, so _any_ outcome — including a failure — is one tap
from correction. This is what unifies "confirm" and "correct" into a single surface:

| Triage outcome (ADR 0012 decision 4)                          | Reply                                          | Button      |
| ------------------------------------------------------------- | ---------------------------------------------- | ----------- |
| Filed into an existing notepad                                | `📓 Filed in *Shopping list* ✓`                | `[✏️ Move]` |
| Filed into a newly-created notepad                            | `🆕 Started *Shopping list* and filed it ✓`    | `[✏️ Move]` |
| Deliberately unfiled (nothing fit)                            | `📥 Kept in your inbox — nothing fit`          | `[✏️ Move]` |
| Failed / still stuck (retries exhausted, ADR 0012 decision 5) | `⚠️ Saved, but I couldn't file it — place it?` | `[✏️ Move]` |

The failure row is the one case that genuinely _needs_ a message: on the happy path a 1–3s wait does
not warrant a pre-triage ack (decision 1), but a note that triage could not place would otherwise
leave the user staring at a sent message with no signal — so the failure gets its own reply, with the
picker attached to fix it by hand.

## Consequences

- The build spec ([#63](https://github.com/bsim0927/ben-os/issues/63)) gains: a `notifyCapture(note,
outcome)` dispatcher plus a Telegram **Outbound adapter** (render text + inline keyboard, call
  `sendMessage`); a **correction op** in `lib/notes` that reassigns `notepad_id` (or creates-then-files)
  through the existing RLS-checked `lib/notes/db.ts` writer; and a `callback_query` branch in the
  Telegram webhook route beside the existing `message` branch, sharing its auth.
- **Triage stays channel-agnostic** end-to-end: it emits a `{ notepad, created?, unfiled?, failed? }`
  outcome and never names a transport. Adding the iOS-widget channel later means one more Outbound
  adapter, no triage change — the same "slots in without a rewrite" property #59 secured for inbound.
- **Re-triage** (ADR 0012 decision 3) is confirmed **out of the phone flow** and into the web manager
  only. The phone's correction is a _direct_ reassignment, which is strictly more explicit than a
  re-triage and never re-arms the model.
- **`raw_text` is never touched** by a correction — a correction only moves `notepad_id` (and on
  `➕ New notepad`, creates a notepad); ADR 0010's immutable-original-capture invariant holds.
- **Media notes** (photos / voice) remain out of v1: a media confirmation would name the same notepad
  through the same Outbound adapter, so this design accommodates them without change, but text-first v1
  does not build them.

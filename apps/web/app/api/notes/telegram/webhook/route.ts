import { messageFor } from "@/lib/errors";
import { notesPool, withAuthorizedSession } from "@/lib/notes/db";
import { ingestNote } from "@/lib/notes/ingest";
import {
  isAllowedChat,
  normalizeTelegramMessage,
  verifyTelegramSecret,
  type TelegramUpdate,
} from "@/lib/notes/telegram";

/** `pg` needs a real socket, which the edge runtime doesn't have. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Telegram inbound webhook: a message to `@BensNoteBot` lands as an
 * unfiled, untriaged `notes_note` row. Telegram POSTs its `Update` here
 * server-to-server, so there is no Google session — the route authenticates
 * the channel itself (secret header + chat allowlist) and the core's write is
 * RLS-gated on top (ADR 0011 dec. 4).
 *
 * The status codes are tuned to how Telegram retries (ADR 0011 dec. 5): it
 * redelivers an update unless it gets a fast `2xx`, so everything the app can
 * safely absorb answers `200` and only a note that isn't durably stored yet
 * answers `500` to invite a retry.
 *
 *   | Case                              | Response     |
 *   | --------------------------------- | ------------ |
 *   | Secret header missing / wrong     | 401          |
 *   | Not a text message we handle      | 200 (drop)   |
 *   | Sender not in the allowlist       | 200 (drop)   |
 *   | Duplicate update_id               | 200 (no-op)  |
 *   | New note landed                   | 200          |
 *   | Genuine insert / infra failure    | 500 (retry)  |
 *
 * Triage is deliberately not run here: the route returns as soon as the row is
 * durable, and an untriaged row is the whole hand-off to triage (ADR 0011
 * dec. 3). Running an LLM inline would blow the fast-200 budget and trigger
 * redelivery storms.
 */
export async function POST(request: Request): Promise<Response> {
  // Not even Telegram — reject outright, before reading the body.
  if (!verifyTelegramSecret(request)) {
    return new Response(null, { status: 401 });
  }

  let update: TelegramUpdate;

  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    // Something that knew the secret sent a non-JSON body — not Telegram's
    // doing. Acknowledge so it isn't retried forever; there's nothing to store.
    return new Response(null, { status: 200 });
  }

  // `request.json()` accepts a bare JSON `null`/number/string too, which would
  // then throw on the `.message` read below. Anything that isn't an object has
  // no update to act on — acknowledge and drop, the same as a non-JSON body.
  if (typeof update !== "object" || update === null) {
    return new Response(null, { status: 200 });
  }

  const message = update.message;

  // Area C captures text messages only. Anything else — a non-text message, or
  // a `callback_query` from a button tap (area E's branch) — is acknowledged
  // and dropped. A 200 stops Telegram redelivering an update we won't act on.
  if (!message || typeof message.text !== "string") {
    return new Response(null, { status: 200 });
  }

  // A sender who isn't Ben. Drop silently with a 200 — don't leak that the
  // endpoint exists, and don't invite retries.
  if (!isAllowedChat(message.chat?.id)) {
    return new Response(null, { status: 200 });
  }

  try {
    await withAuthorizedSession(notesPool(), (unitOfWork) =>
      ingestNote({ normalized: normalizeTelegramMessage(update), unitOfWork }),
    );

    // `landed` and `deduped` are both fine: the note is durably stored, either
    // just now or on the delivery this one duplicates. `failed` is a normalized
    // shape the adapter should never have produced — a *permanent* rejection,
    // not a transient one, so it drops with a 200 rather than a 500. A 500 here
    // would tell Telegram to redeliver a note that can never be stored, forever;
    // only the thrown infra failure below is worth a retry (ADR 0011 dec. 5).
    return new Response(null, { status: 200 });
  } catch (cause) {
    // The insert or the database itself failed — the note is not safely stored,
    // so let Telegram retry rather than swallow it.
    return Response.json({ error: messageFor(cause) }, { status: 500 });
  }
}

/**
 * The Telegram inbound adapter — channel #1's half of the ingest boundary.
 *
 * Telegram POSTs its own `Update` shape to `/api/notes/telegram/webhook`; this
 * module owns the Telegram-specific work the shared ingest core must not know
 * about (ADR 0011 dec. 1): proving the caller is Telegram and the sender is
 * Ben, and mapping the native payload to the normalized quartet the core
 * consumes. A future iOS widget brings its own adapter with its own auth and
 * mapping, then calls the *same* `ingestNote()` — nothing here leaks into the
 * core.
 *
 * Two independent checks gate a capture (ADR 0011 dec. 4): the
 * `X-Telegram-Bot-Api-Secret-Token` header proves the request is Telegram, and
 * the `TELEGRAM_ALLOWED_CHAT_ID` allowlist proves the sender is the one person
 * allowed to file notes. Both are enforced here in the adapter; the core's
 * insert is then RLS-gated on top, so `is_authorized()` remains the final word
 * on every write.
 */

import { timingSafeEqual } from "node:crypto";

import type { NormalizedNote } from "@/lib/notes/ingest";

/**
 * The slice of Telegram's `Update` this adapter reads. Telegram sends far more
 * fields; typing only what capture needs keeps the mapping honest about its
 * inputs. `message` is optional because an update may carry something else
 * entirely (a `callback_query` from a button tap — area E's concern), which
 * this area acknowledges and drops.
 */
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  /** Unix time in *seconds* (Telegram's convention), not milliseconds. */
  date: number;
  /** Absent for non-text messages (a photo, a sticker) — those aren't notes. */
  text?: string;
  chat: { id: number };
};

/**
 * Proves the request came from Telegram by matching the secret token Telegram
 * echoes in `X-Telegram-Bot-Api-Secret-Token` against the one we registered
 * with `setWebhook`. Fails closed: an unset `TELEGRAM_WEBHOOK_SECRET` means
 * "reject", never "let everyone in" — the same misconfiguration stance the
 * cron gate takes. Compared in constant time so response timing can't recover
 * the secret a character at a time.
 */
export function verifyTelegramSecret(request: Request): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  // Fail closed. Without a configured secret there is no way to authenticate a
  // caller, so nothing is authentic.
  if (!secret) {
    return false;
  }

  const header = request.headers.get("x-telegram-bot-api-secret-token");

  if (!header) {
    return false;
  }

  return constantTimeEquals(header, secret);
}

/**
 * Proves the sender is Ben: the message's chat id must equal the single
 * `TELEGRAM_ALLOWED_CHAT_ID` allowlist entry (chat `5694272797`). Compared as
 * strings so the env var — always a string — needs no parsing, and fails
 * closed when the allowlist is unset. A non-allowlisted sender is dropped with
 * a 200 by the route, never told the endpoint exists.
 */
export function isAllowedChat(chatId: number | undefined): boolean {
  const allowed = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim();

  if (!allowed) {
    return false;
  }

  return chatId !== undefined && String(chatId) === allowed;
}

/**
 * Maps a Telegram text message to the normalized quartet (ADR 0011 dec. 2).
 * `update_id` becomes `source.external_id` — the stable dedup key the
 * idempotency index keys on, so a redelivered update collides and no-ops.
 * `date` is Telegram's Unix *seconds*, so ×1000 for a JS `Date`. The caller
 * guarantees `message` and `message.text` are present (the route drops
 * everything else first); this reads them directly.
 */
export function normalizeTelegramMessage(update: TelegramUpdate): NormalizedNote {
  const message = update.message as TelegramMessage & { text: string };

  return {
    raw_text: message.text,
    channel: "telegram",
    source: {
      external_id: String(update.update_id),
      chat_id: message.chat.id,
      message_id: message.message_id,
    },
    captured_at: new Date(message.date * 1000),
  };
}

/**
 * Registers this route as the bot's webhook, with the secret token Telegram
 * will echo back on every delivery.
 *
 * This is the operational counterpart to the adapter: run once (and again
 * whenever the deployed URL or the secret changes) against the live Telegram
 * API. `allowed_updates` includes `callback_query` now so the correction
 * branch (area E) needs no re-registration — until it exists those updates
 * simply arrive and are dropped, which is harmless. Returns Telegram's own
 * JSON response so the caller can see `{ ok: true }` or the reason it refused.
 */
export async function setTelegramWebhook({
  token,
  url,
  secret,
}: {
  token: string;
  url: string;
  secret: string;
}): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
    }),
  });

  return response.json();
}

/**
 * Constant-time string compare. `timingSafeEqual` throws when the buffers
 * differ in length, which would itself leak length, so lengths are checked
 * first and a mismatch short-circuits to `false`. Kept local to the adapter
 * rather than shared: it is a few lines, and this module's siblings
 * (`financials/`, and `lib/cron.ts`) each keep their own for the same reason.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isAllowedChat,
  normalizeTelegramMessage,
  verifyTelegramSecret,
  type TelegramUpdate,
} from "@/lib/notes/telegram";

/**
 * The Telegram adapter's pure pieces — auth checks and the payload→normalized
 * mapping. The route wires these together; here each is exercised on its own.
 */

function update(
  overrides: Partial<TelegramUpdate["message"]> = {},
  updateId = 555,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1_786_785_420, // 2026-08-15T09:17:00Z in Unix seconds
      text: "buy mangoes",
      chat: { id: 5694272797 },
      ...overrides,
    },
  };
}

describe("verifyTelegramSecret", () => {
  const secret = "s3cr3t-webhook-token";

  function request(header?: string): Request {
    return new Request("https://ben-os.test/api/notes/telegram/webhook", {
      method: "POST",
      headers: header === undefined ? {} : { "x-telegram-bot-api-secret-token": header },
    });
  }

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
  });
  afterEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it("accepts the matching secret token", () => {
    expect(verifyTelegramSecret(request(secret))).toBe(true);
  });

  it("rejects a wrong or missing header", () => {
    expect(verifyTelegramSecret(request("wrong"))).toBe(false);
    expect(verifyTelegramSecret(request())).toBe(false);
  });

  it("fails closed when the secret is not configured", () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    // Even a header that happens to match nothing must be rejected — an unset
    // secret can never mean "let everyone in".
    expect(verifyTelegramSecret(request(secret))).toBe(false);
  });
});

describe("isAllowedChat", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_ALLOWED_CHAT_ID;
  });

  it("accepts only the allowlisted chat id", () => {
    process.env.TELEGRAM_ALLOWED_CHAT_ID = "5694272797";
    expect(isAllowedChat(5694272797)).toBe(true);
    expect(isAllowedChat(999)).toBe(false);
    expect(isAllowedChat(undefined)).toBe(false);
  });

  it("fails closed when the allowlist is unset", () => {
    expect(isAllowedChat(5694272797)).toBe(false);
  });
});

describe("normalizeTelegramMessage", () => {
  it("maps the native payload to the normalized quartet (ADR 0011 dec. 2)", () => {
    expect(normalizeTelegramMessage(update())).toEqual({
      raw_text: "buy mangoes",
      channel: "telegram",
      source: { external_id: "555", chat_id: 5694272797, message_id: 7 },
      // Unix seconds ×1000 — the sender's own timestamp.
      captured_at: new Date("2026-08-15T09:17:00.000Z"),
    });
  });

  it("carries update_id into source.external_id as a string — the dedup key", () => {
    const { source } = normalizeTelegramMessage(update({}, 42));
    expect(source.external_id).toBe("42");
  });
});

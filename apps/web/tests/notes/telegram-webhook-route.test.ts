// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withAuthorizedSession, notesPool, ingestNote } = vi.hoisted(() => ({
  withAuthorizedSession: vi.fn(),
  notesPool: vi.fn(),
  ingestNote: vi.fn(),
}));

vi.mock("@/lib/notes/db", () => ({ withAuthorizedSession, notesPool }));
vi.mock("@/lib/notes/ingest", () => ({ ingestNote }));

import { POST } from "@/app/api/notes/telegram/webhook/route";

const SECRET = "s3cr3t-webhook-token";
const ALLOWED_CHAT = 5694272797;

type MessageOverrides = { text?: string; chat?: { id: number } };

function webhookRequest(
  body: unknown,
  { secret = SECRET }: { secret?: string | null } = {},
): Request {
  return new Request("https://ben-os.test/api/notes/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function textUpdate(overrides: MessageOverrides = {}, updateId = 555) {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1_786_785_420,
      text: "buy mangoes",
      chat: { id: ALLOWED_CHAT },
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEGRAM_ALLOWED_CHAT_ID = String(ALLOWED_CHAT);
  // Hand the route's callback a unit-of-work it can call without a database.
  withAuthorizedSession.mockImplementation((_pool, fn) => fn(vi.fn()));
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_ALLOWED_CHAT_ID;
});

describe("POST /api/notes/telegram/webhook", () => {
  it("rejects a bad/missing secret with 401, before reading the body", async () => {
    expect((await POST(webhookRequest(textUpdate(), { secret: "wrong" }))).status).toBe(401);
    expect((await POST(webhookRequest(textUpdate(), { secret: null }))).status).toBe(401);
    expect(ingestNote).not.toHaveBeenCalled();
  });

  it("drops a non-allowlisted sender with 200 and no insert", async () => {
    const response = await POST(webhookRequest(textUpdate({ chat: { id: 999 } })));

    expect(response.status).toBe(200);
    expect(ingestNote).not.toHaveBeenCalled();
  });

  it("acknowledges a non-text update with 200 and no insert", async () => {
    // A photo/sticker message (no `text`) — nothing to capture in area C.
    const response = await POST(
      webhookRequest({
        update_id: 1,
        message: { message_id: 7, date: 1, chat: { id: ALLOWED_CHAT } },
      }),
    );

    expect(response.status).toBe(200);
    expect(ingestNote).not.toHaveBeenCalled();
  });

  it("acknowledges an update with no message (e.g. a callback_query) with 200", async () => {
    const response = await POST(webhookRequest({ update_id: 1, callback_query: { id: "cb" } }));

    expect(response.status).toBe(200);
    expect(ingestNote).not.toHaveBeenCalled();
  });

  it("returns 200 and normalizes the payload when a new note lands", async () => {
    ingestNote.mockResolvedValue({ status: "landed", id: "note-1" });

    const response = await POST(webhookRequest(textUpdate({}, 555)));

    expect(response.status).toBe(200);
    expect(ingestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        normalized: {
          raw_text: "buy mangoes",
          channel: "telegram",
          source: { external_id: "555", chat_id: ALLOWED_CHAT, message_id: 7 },
          captured_at: new Date("2026-08-15T09:17:00.000Z"),
        },
      }),
    );
  });

  it("returns 200 for a duplicate update_id (the core deduped it)", async () => {
    ingestNote.mockResolvedValue({ status: "deduped" });

    expect((await POST(webhookRequest(textUpdate()))).status).toBe(200);
  });

  it("drops a failed (permanently unprocessable) outcome with 200, not a retry-inviting 500", async () => {
    // `failed` is a validation rejection the adapter should never produce — it
    // can't be fixed by redelivery, so it must not answer 500 (which Telegram
    // reads as "retry"). Only a thrown infra failure earns a 500.
    ingestNote.mockResolvedValue({
      status: "failed",
      reason: "raw_text must be a non-empty string.",
    });

    const response = await POST(webhookRequest(textUpdate()));

    expect(response.status).toBe(200);
  });

  it("returns 500 when the insert throws, so Telegram retries", async () => {
    ingestNote.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const response = await POST(webhookRequest(textUpdate()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: /connection terminated/ as unknown as string,
    });
  });

  it("acknowledges a malformed (non-JSON) body with 200", async () => {
    const response = await POST(webhookRequest("not json"));

    expect(response.status).toBe(200);
    expect(ingestNote).not.toHaveBeenCalled();
  });

  it("acknowledges a body that parses to a non-object (JSON null) with 200, not a crash", async () => {
    // `request.json()` accepts a bare `null`; reading `.message` off it would
    // throw and surface as a framework 500. It must drop cleanly instead.
    const response = await POST(webhookRequest("null"));

    expect(response.status).toBe(200);
    expect(ingestNote).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { withAuthorizedSession } from "@/lib/notes/db";
import { ingestNote, type NormalizedNote } from "@/lib/notes/ingest";

import { asSuperuser, closeTestPool, resetNotes, testPool } from "../support/database";

/**
 * The ingest core against a real Postgres with RLS live — the same reasons
 * `db.test.ts` uses a real database apply here: the dedup is an `on conflict`
 * against a partial unique index, and "landed vs deduped" is `rowCount` from
 * the driver, neither of which a fake query layer would prove.
 *
 * Each case drives the production `ingestNote` through the production
 * `withAuthorizedSession`, exactly as the webhook route will.
 */
beforeEach(resetNotes);
afterAll(closeTestPool);

function normalized(overrides: Partial<NormalizedNote> = {}): NormalizedNote {
  return {
    raw_text: "buy mangoes",
    channel: "telegram",
    source: { external_id: "42", chat_id: 5694272797, message_id: 7 },
    captured_at: new Date("2026-08-15T09:17:00.000Z"),
    ...overrides,
  };
}

async function ingest(note: NormalizedNote) {
  return withAuthorizedSession(testPool(), (unitOfWork) =>
    ingestNote({ normalized: note, unitOfWork }),
  );
}

describe("ingestNote", () => {
  it("lands an unfiled, untriaged row and derives body/notepad_id/triaged_at itself", async () => {
    const outcome = await ingest(normalized());

    expect(outcome.status).toBe("landed");

    const { rows } = await asSuperuser((query) =>
      query(`select notepad_id, raw_text, body, channel, source, captured_at,
                     triaged_at, structure, triage
                from public.notes_note`),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // The core derives these, not the adapter (ADR 0011 dec. 2).
      notepad_id: null,
      body: "buy mangoes",
      raw_text: "buy mangoes",
      channel: "telegram",
      // The whole capture→triage hand-off: the row lands untriaged and the core
      // never runs triage (ADR 0011 dec. 3).
      triaged_at: null,
    });
    // captured_at is the sender's timestamp, preserved verbatim.
    expect((rows[0].captured_at as Date).toISOString()).toBe("2026-08-15T09:17:00.000Z");
    // jsonb defaults land as empty objects — triage has written nothing.
    expect(rows[0].structure).toEqual({});
    expect(rows[0].triage).toEqual({});
    // The whole source bag is stored for provenance.
    expect(rows[0].source).toEqual({ external_id: "42", chat_id: 5694272797, message_id: 7 });
  });

  it("returns the landed row's id", async () => {
    const outcome = await ingest(normalized());

    expect(outcome).toMatchObject({ status: "landed", id: expect.any(String) });

    const { rows } = await asSuperuser((query) => query("select id from public.notes_note"));
    expect(outcome.status === "landed" && outcome.id).toBe(rows[0].id);
  });

  it("dedupes a redelivered update to a no-op, leaving one row", async () => {
    expect((await ingest(normalized({ source: { external_id: "100" } }))).status).toBe("landed");
    // Telegram retried the same update_id because it didn't get a fast 200.
    expect((await ingest(normalized({ source: { external_id: "100" } }))).status).toBe("deduped");
    // A different update lands normally.
    expect((await ingest(normalized({ source: { external_id: "101" } }))).status).toBe("landed");

    const { rows } = await asSuperuser((query) =>
      query("select count(*)::int as n from public.notes_note"),
    );
    expect(rows[0].n).toBe(2);
  });

  it("is channel-agnostic — it inserts whatever discriminator the adapter passes", async () => {
    const outcome = await ingest(
      normalized({ channel: "ios-widget", source: { external_id: "w-1" } }),
    );

    expect(outcome.status).toBe("landed");
    const { rows } = await asSuperuser((query) =>
      query("select channel, triaged_at from public.notes_note"),
    );
    // A future channel routes through the same core, still untriaged, no
    // Telegram assumptions baked in.
    expect(rows[0]).toEqual({ channel: "ios-widget", triaged_at: null });
  });

  it("rejects a malformed normalized shape without touching the table", async () => {
    const outcome = await ingest(normalized({ raw_text: "" }));

    expect(outcome).toMatchObject({ status: "failed", reason: expect.stringMatching(/raw_text/) });

    const { rows } = await asSuperuser((query) =>
      query("select count(*)::int as n from public.notes_note"),
    );
    expect(rows[0].n).toBe(0);
  });
});

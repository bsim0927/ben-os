// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { withAuthorizedSession } from "@/lib/notes/db";
import { ALLOWED_EMAIL } from "@/lib/auth";

import { asUser, closeTestPool, resetNotes, testPool } from "../support/database";

/**
 * The Notes writer against a real Postgres with RLS live. The point isn't the
 * SQL dialect — it's that `withAuthorizedSession`, the one path every
 * server-side Notes write takes, is gated by `is_authorized()` exactly like a
 * web write, with no service-role bypass. A fake query layer would prove the
 * test's model of the policy, not the policy.
 *
 * Every run goes through the production `withAuthorizedSession` (the same helper
 * the ingest webhook, triage, and correction will use), pointed at the run-wide
 * test Postgres.
 */
beforeEach(resetNotes);
afterAll(closeTestPool);

describe("withAuthorizedSession", () => {
  it("round-trips a captured note: insert then read-back both succeed under is_authorized()", async () => {
    const readBack = await withAuthorizedSession(testPool(), (unitOfWork) =>
      unitOfWork(async (query) => {
        const { rows: pads } = await query(
          `insert into public.notes_notepad (name, description)
           values ('Groceries', 'Groceries and household items to buy.')
           returning id`,
        );
        const notepadId = pads[0].id as string;

        await query(
          `insert into public.notes_note (notepad_id, raw_text, body, channel, source, captured_at)
           values ($1, $2, $2, 'telegram', $3, now())`,
          [notepadId, "buy mangoes", JSON.stringify({ external_id: "42", chat_id: 5694272797 })],
        );

        const { rows } = await query(
          `select notepad_id, raw_text, body, channel, structure, triage, triaged_at
             from public.notes_note`,
        );

        return rows[0];
      }),
    );

    expect(readBack).toMatchObject({
      raw_text: "buy mangoes",
      body: "buy mangoes",
      channel: "telegram",
      // ADR 0010 dec. 5: a freshly captured note is unfiled and untriaged until
      // triage runs — the entire capture→triage hand-off.
      triaged_at: null,
    });
    // The jsonb defaults land as empty objects, not null.
    expect(readBack.structure).toEqual({});
    expect(readBack.triage).toEqual({});
  });

  it("dedupes a redelivered webhook via the (channel, external_id) idempotency index", async () => {
    const landed = async (updateId: string) =>
      withAuthorizedSession(testPool(), (unitOfWork) =>
        unitOfWork(async (query) => {
          const { rowCount } = await query(
            `insert into public.notes_note (raw_text, body, channel, source, captured_at)
             values ($1, $1, 'telegram', $2, now())
             on conflict (channel, (source->>'external_id'))
               where source->>'external_id' is not null
               do nothing`,
            ["buy mangoes", JSON.stringify({ external_id: updateId })],
          );

          return rowCount ?? 0;
        }),
      );

    expect(await landed("100")).toBe(1);
    // Same update_id: Telegram retried because we didn't 200 fast enough. The
    // partial unique index makes it a no-op (ADR 0010 dec. 8).
    expect(await landed("100")).toBe(0);
    expect(await landed("101")).toBe(1);
  });

  it("orphans a deleted non-empty notepad's notes back to the inbox, not blocking the delete", async () => {
    // Build spec: "Delete a non-empty notepad -> orphan its notes to Inbox
    // (notepad_id IS NULL), not block-until-empty." `on delete set null` makes
    // that atomic instead of forcing a reassign-then-delete.
    const notepadId = await withAuthorizedSession(testPool(), (unitOfWork) =>
      unitOfWork(async (query) => {
        const { rows } = await query(
          `insert into public.notes_notepad (name) values ('Groceries') returning id`,
        );
        const id = rows[0].id as string;

        await query(
          `insert into public.notes_note (notepad_id, raw_text, body, channel, captured_at)
           values ($1, 'buy mangoes', 'buy mangoes', 'telegram', now())`,
          [id],
        );

        return id;
      }),
    );

    const orphaned = await withAuthorizedSession(testPool(), (unitOfWork) =>
      unitOfWork(async (query) => {
        await query("delete from public.notes_notepad where id = $1", [notepadId]);

        const { rows } = await query("select notepad_id from public.notes_note");

        return rows;
      }),
    );

    expect(orphaned).toEqual([{ notepad_id: null }]);
  });
});

describe("row level security", () => {
  it("hides both notes tables from a caller who is not the authorized user", async () => {
    await withAuthorizedSession(testPool(), (unitOfWork) =>
      unitOfWork((query) =>
        query(
          `insert into public.notes_note (raw_text, body, channel, captured_at)
           values ('a secret note', 'a secret note', 'telegram', now())`,
        ),
      ),
    );

    const visible = await asUser("someone-else@example.test", async (query) => {
      const { rows } = await query(`select
          (select count(*) from public.notes_notepad) as notepads,
          (select count(*) from public.notes_note) as notes`);

      return rows[0];
    });

    expect(visible).toEqual({ notepads: "0", notes: "0" });
  });

  it("refuses a write from a caller who is not the authorized user", async () => {
    await expect(
      asUser("someone-else@example.test", (query) =>
        query(
          `insert into public.notes_note (raw_text, body, channel, captured_at)
           values ('sneaky', 'sneaky', 'telegram', now())`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("shows the authorized user the note the writer wrote", async () => {
    await withAuthorizedSession(testPool(), (unitOfWork) =>
      unitOfWork((query) =>
        query(
          `insert into public.notes_note (raw_text, body, channel, captured_at)
           values ('visible', 'visible', 'telegram', now())`,
        ),
      ),
    );

    const { rows } = await asUser(ALLOWED_EMAIL, (query) =>
      query("select count(*)::int as n from public.notes_note"),
    );

    expect(rows[0].n).toBe(1);
  });
});

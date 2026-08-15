/**
 * The Notes ingest core — the one channel-agnostic path a captured note takes
 * to become a `notes_note` row.
 *
 * A channel never posts a "normalized note"; it POSTs its own webhook shape to
 * its own route, where a per-channel *adapter* authenticates it and maps the
 * native payload to the normalized quartet below (`lib/notes/telegram.ts` is
 * adapter #1). Every adapter then calls this one `ingestNote()`, so the
 * validate/dedup/insert invariants live in a single place and adding a channel
 * is a new adapter, not a new copy of the insert (ADR 0011 dec. 1).
 *
 * The core's responsibility ends at a durably-landed row with `triaged_at IS
 * NULL`. It **never runs triage**: an untriaged row is the entire hand-off to
 * triage (ADR 0011 dec. 3), and running an LLM inside the capture path would
 * blow the fast-`200` budget the webhook lives under. Whether triage fires
 * on-arrival, on a cron, or on demand is decided elsewhere (#60) and this
 * boundary must not presuppose it.
 */

import type { UnitOfWork } from "@/lib/notes/db";

/**
 * The normalized inbound shape — an adapter's whole output (ADR 0011 dec. 2),
 * exactly ADR 0010's provenance quartet. The core derives everything else:
 * `body := raw_text`, `notepad_id := null`, `triaged_at := null`.
 */
export type NormalizedNote = {
  /** The message text, verbatim — becomes `notes_note.raw_text` (and `body`). */
  raw_text: string;
  /** The channel discriminator: `'telegram'` for v1. */
  channel: string;
  /**
   * Channel-specific identifiers. A stable `source.external_id` is the dedup
   * key the idempotency index keys on (ADR 0010 dec. 8); a channel with no
   * natural id simply omits it and is exempt from dedup (the index is partial).
   */
  source: { external_id?: string; [key: string]: unknown };
  /** The sender's own timestamp, NOT row-insert time (kept as `captured_at`). */
  captured_at: Date;
};

/**
 * What became of the note. The adapter maps this to its transport's status —
 * for Telegram all three settle as a 200 (ADR 0011 dec. 5): `landed` and
 * `deduped` are both durably stored, and `failed` is a *permanent* rejection
 * that redelivery can't fix, so it drops rather than inviting a retry. Only a
 * genuine database/infra failure earns a 500, and that is *thrown*, not
 * returned — the adapter's catch turns it into a retry for a note that isn't
 * safely stored. `failed` is reserved for a normalized shape the adapter
 * should never have produced — a defensive boundary, not the retry path.
 */
export type IngestOutcome =
  { status: "landed"; id: string } | { status: "deduped" } | { status: "failed"; reason: string };

/**
 * Validates the normalized quartet, dedups on the idempotency index, and
 * inserts the row through the area-B authorized writer.
 *
 * `unitOfWork` is the caller's transaction runner (`withAuthorizedSession`),
 * so the insert passes `is_authorized()` RLS exactly like a web write — there
 * is no service-role bypass on this path (ADR 0011 dec. 4). The insert is a
 * single `insert … on conflict do nothing`: a redelivered webhook (Telegram
 * retries when it doesn't get a fast 200) collides on `(channel,
 * external_id)` and no-ops, which `rowCount` reports as a dedup without a
 * second `returning`.
 */
export async function ingestNote({
  normalized,
  unitOfWork,
}: {
  normalized: NormalizedNote;
  unitOfWork: UnitOfWork;
}): Promise<IngestOutcome> {
  const invalid = validationError(normalized);

  if (invalid) {
    return { status: "failed", reason: invalid };
  }

  return unitOfWork(async (query) => {
    const { rows, rowCount } = await query(
      `insert into public.notes_note (raw_text, body, channel, source, captured_at)
       values ($1, $1, $2, $3, $4)
       on conflict (channel, (source->>'external_id'))
         where source->>'external_id' is not null
         do nothing
       returning id`,
      [
        normalized.raw_text,
        normalized.channel,
        JSON.stringify(normalized.source),
        normalized.captured_at,
      ],
    );

    // `do nothing` returns no row on a conflict, so an empty result is the
    // redelivery no-op — a durable earlier copy already exists.
    if (rowCount === 1 && rows[0]) {
      return { status: "landed", id: rows[0].id as string };
    }

    return { status: "deduped" };
  });
}

/**
 * The defensive gate on the normalized shape. The adapter is supposed to hand
 * a well-formed quartet; this catches an adapter bug (or a channel payload
 * that slipped past one) before it reaches Postgres, and names what was wrong
 * so the failure isn't a bare constraint violation from the driver. Returns a
 * reason string when the shape is unusable, or `null` when it is fine.
 */
function validationError(normalized: NormalizedNote): string | null {
  if (typeof normalized.raw_text !== "string" || normalized.raw_text.length === 0) {
    return "raw_text must be a non-empty string.";
  }

  if (typeof normalized.channel !== "string" || normalized.channel.length === 0) {
    return "channel must be a non-empty string.";
  }

  if (normalized.source === null || typeof normalized.source !== "object") {
    return "source must be an object.";
  }

  if (!(normalized.captured_at instanceof Date) || Number.isNaN(normalized.captured_at.getTime())) {
    return "captured_at must be a valid Date.";
  }

  return null;
}

/**
 * What the shell's freshness chip says.
 *
 * The chip is shell-owned (issue #5) but only a module has sync state, so the
 * shell reaches for it through this one named function rather than knowing any
 * `financials_*` table. Financials is the only module with data today; when a
 * second one has some, this is the seam that becomes a registry lookup rather
 * than a rewrite of the layout.
 *
 * "Last synced" is the newest `financials_balance_snapshot.created_at`: a
 * snapshot is written for every account on every successful poll, so it is the
 * closest thing to "when did the sync last get through". It reports the last
 * connection that succeeded, not that all of them did — one bank being broken
 * is the normal case (ADR 0005), and a chip is the wrong place to litigate it.
 */

import { createClient } from "@/lib/supabase/server";

export type SyncStatus = {
  /** Connections, not accounts — one login is one source, whatever it exposes. */
  sources: number;
  lastSyncedAt: string | null;
};

export type SyncSummary = {
  /** The crumb row's chip. */
  chip: string;
  /** The sidebar's account-chip line. */
  lastSynced: string;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `null` when the tables could not be read — which must not read as "nothing connected". */
export async function readSyncStatus(): Promise<SyncStatus | null> {
  const supabase = await createClient();

  const [connections, latest] = await Promise.all([
    supabase.from("financials_connection").select("id").returns<{ id: string }[]>(),
    supabase
      .from("financials_balance_snapshot")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .returns<{ created_at: string }[]>(),
  ]);

  if (connections.error || latest.error) return null;

  return {
    sources: connections.data?.length ?? 0,
    lastSyncedAt: latest.data?.[0]?.created_at ?? null,
  };
}

export function describeSyncStatus(status: SyncStatus | null, now: Date): SyncSummary {
  // An unreadable table is not an empty one. Saying "No sources connected"
  // here would turn a permissions problem into a confident lie about the
  // user's accounts.
  if (status === null) return { chip: "Sync status unavailable", lastSynced: "Unknown" };

  if (status.sources === 0) return { chip: "No sources connected", lastSynced: "No syncs yet" };

  const sources = `${status.sources} ${status.sources === 1 ? "source" : "sources"}`;

  if (status.lastSyncedAt === null) {
    return { chip: `${sources} · never synced`, lastSynced: "No syncs yet" };
  }

  const ago = timeAgo(status.lastSyncedAt, now);

  return { chip: `${sources} · synced ${ago}`, lastSynced: ago };
}

/**
 * Coarse on purpose: the sync runs daily, so minute-precision would imply a
 * freshness the schedule cannot deliver. Anything past a week reads as a date,
 * because "23d ago" stops being something you can picture.
 */
function timeAgo(timestamp: string, now: Date): string {
  const then = new Date(timestamp);
  const elapsed = now.getTime() - then.getTime();

  if (Number.isNaN(then.getTime())) return "at an unknown time";
  // A clock skew between the database and the renderer must not read as the
  // future, which would look like a bug in the sync rather than in the clocks.
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;

  return `on ${then.toISOString().slice(0, 10)}`;
}

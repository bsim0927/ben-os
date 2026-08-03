import { describe, expect, it } from "vitest";

import { describeSyncStatus } from "@/lib/financials/sync-status";

const NOW = new Date("2026-08-02T21:00:00Z");

describe("describeSyncStatus", () => {
  it("counts connections as sources and says how long ago the sync got through", () => {
    expect(describeSyncStatus({ sources: 2, lastSyncedAt: "2026-08-02T20:43:17Z" }, NOW)).toEqual({
      chip: "2 sources · synced 16m ago",
      lastSynced: "16m ago",
    });
  });

  it("counts one source in the singular", () => {
    expect(describeSyncStatus({ sources: 1, lastSyncedAt: "2026-08-02T20:00:00Z" }, NOW).chip).toBe(
      "1 source · synced 1h ago",
    );
  });

  it("says nothing is connected only when nothing is", () => {
    expect(describeSyncStatus({ sources: 0, lastSyncedAt: null }, NOW)).toEqual({
      chip: "No sources connected",
      lastSynced: "No syncs yet",
    });
  });

  it("distinguishes a connected source that has never synced from no source at all", () => {
    expect(describeSyncStatus({ sources: 1, lastSyncedAt: null }, NOW)).toEqual({
      chip: "1 source · never synced",
      lastSynced: "No syncs yet",
    });
  });

  it("does not report an unreadable table as an empty one", () => {
    // Saying "No sources connected" here would turn a permissions problem into
    // a confident lie about the user's accounts.
    expect(describeSyncStatus(null, NOW)).toEqual({
      chip: "Sync status unavailable",
      lastSynced: "Unknown",
    });
  });

  it("coarsens with age, because a daily sync cannot support minute precision", () => {
    const ago = (iso: string) =>
      describeSyncStatus({ sources: 1, lastSyncedAt: iso }, NOW).lastSynced;

    expect(ago("2026-08-02T20:59:30Z")).toBe("just now");
    expect(ago("2026-08-02T20:30:00Z")).toBe("30m ago");
    expect(ago("2026-08-02T13:00:00Z")).toBe("8h ago");
    expect(ago("2026-07-31T21:00:00Z")).toBe("2d ago");
  });

  it("falls back to a date once 'N days ago' stops being something you can picture", () => {
    expect(
      describeSyncStatus({ sources: 1, lastSyncedAt: "2026-07-01T09:00:00Z" }, NOW).lastSynced,
    ).toBe("on 2026-07-01");
  });

  it("reads a clock skew into the future as just now, not as a broken sync", () => {
    expect(
      describeSyncStatus({ sources: 1, lastSyncedAt: "2026-08-02T21:00:30Z" }, NOW).lastSynced,
    ).toBe("just now");
  });

  it("says so plainly when the timestamp cannot be read", () => {
    expect(describeSyncStatus({ sources: 1, lastSyncedAt: "not a date" }, NOW).lastSynced).toBe(
      "at an unknown time",
    );
  });
});

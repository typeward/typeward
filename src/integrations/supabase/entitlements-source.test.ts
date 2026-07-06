import { describe, expect, it } from "vitest";

import {
  CACHE_TTL_MS,
  CLOCK_SKEW_MS,
  isSnapshotUsable,
  type CachedSnapshot,
} from "./entitlements-source";

const NOW = Date.UTC(2026, 6, 6, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function snapshot(overrides: Partial<CachedSnapshot> = {}): CachedSnapshot {
  return {
    fetchedAt: NOW - HOUR,
    rows: [{ plan_id: "pro", feature_key: "integrations.cloud.dropbox", value: "true" }],
    plan: "pro",
    lastSeenWallClock: NOW - HOUR,
    ...overrides,
  };
}

describe("isSnapshotUsable", () => {
  it("accepts a fresh snapshot", () => {
    expect(isSnapshotUsable(snapshot(), NOW)).toBe(true);
  });

  it("accepts a legacy snapshot without lastSeenWallClock", () => {
    expect(
      isSnapshotUsable(snapshot({ lastSeenWallClock: undefined }), NOW),
    ).toBe(true);
  });

  it("expires at the 30-day TTL boundary", () => {
    expect(
      isSnapshotUsable(snapshot({ fetchedAt: NOW - CACHE_TTL_MS + 1, lastSeenWallClock: undefined }), NOW),
    ).toBe(true);
    expect(
      isSnapshotUsable(snapshot({ fetchedAt: NOW - CACHE_TTL_MS, lastSeenWallClock: undefined }), NOW),
    ).toBe(false);
    expect(
      isSnapshotUsable(snapshot({ fetchedAt: NOW - 31 * DAY, lastSeenWallClock: undefined }), NOW),
    ).toBe(false);
  });

  it("still serves a 29-day-old snapshot", () => {
    expect(isSnapshotUsable(snapshot({ fetchedAt: NOW - 29 * DAY }), NOW)).toBe(true);
  });

  it("rejects fetchedAt in the future beyond the skew allowance", () => {
    expect(
      isSnapshotUsable(
        snapshot({ fetchedAt: NOW + CLOCK_SKEW_MS + 1, lastSeenWallClock: undefined }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSnapshotUsable(snapshot({ fetchedAt: NOW + DAY, lastSeenWallClock: undefined }), NOW),
    ).toBe(false);
  });

  it("tolerates fetchedAt within the skew allowance", () => {
    expect(
      isSnapshotUsable(
        snapshot({ fetchedAt: NOW + CLOCK_SKEW_MS - 1, lastSeenWallClock: undefined }),
        NOW,
      ),
    ).toBe(true);
  });

  it("rejects when the wall clock moved backwards past lastSeenWallClock", () => {
    expect(
      isSnapshotUsable(snapshot({ lastSeenWallClock: NOW + CLOCK_SKEW_MS + 1 }), NOW),
    ).toBe(false);
    expect(
      isSnapshotUsable(snapshot({ lastSeenWallClock: NOW + 3 * DAY }), NOW),
    ).toBe(false);
  });

  it("tolerates backwards drift within the skew allowance", () => {
    expect(
      isSnapshotUsable(snapshot({ lastSeenWallClock: NOW + CLOCK_SKEW_MS - 1 }), NOW),
    ).toBe(true);
  });

  it("is unaffected by wall-clock timezone or DST shifts", () => {
    // Date.now() is UTC-epoch: a timezone/DST change alters local rendering,
    // not the epoch value, so `now` simply keeps advancing. Only a real
    // system-clock jump changes the inputs here.
    const afterDstStyleHourForward = NOW + HOUR;
    expect(isSnapshotUsable(snapshot(), afterDstStyleHourForward)).toBe(true);
  });

  it("rejects a corrupted fetchedAt", () => {
    expect(
      isSnapshotUsable(snapshot({ fetchedAt: Number.NaN, lastSeenWallClock: undefined }), NOW),
    ).toBe(false);
    expect(
      isSnapshotUsable(
        snapshot({ fetchedAt: undefined as unknown as number, lastSeenWallClock: undefined }),
        NOW,
      ),
    ).toBe(false);
  });
});

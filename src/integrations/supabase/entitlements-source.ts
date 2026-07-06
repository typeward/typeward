/**
 * Real entitlement source backed by `get_entitlements()` on Supabase.
 *
 * Lifecycle:
 *   - At sign-in time, fetch the RPC, snapshot the result in memory +
 *     persist a JSON copy to the OS keyring so the user can keep their
 *     entitlements offline.
 *   - At sign-out, swap back to the free-tier stub.
 *   - On boot (with a persisted session), restore the cached snapshot
 *     immediately, then re-fetch in the background to refresh.
 *   - On window focus (throttled to once per 30s) and via the manual
 *     "Refresh plan" button, `refreshEntitlements()` re-runs the fetch.
 *
 * Cache TTL is 30 days; after that we collapse to free-tier and surface
 * an in-app banner the user can dismiss by going online. Cheap clock-tamper
 * guards reject a snapshot stamped in the future or read after the wall
 * clock moved backwards past `lastSeenWallClock` — determined tampering
 * wins anyway, these only raise the floor.
 */

import { createEffect, createRoot, createSignal } from "solid-js";

import { recordError } from "~/lib/telemetry";
import { notifyError } from "~/lib/toast";
import { resetEntitlementSource, setEntitlementSource } from "~/integrations/entitlements";
import type {
  EntitlementKey,
  EntitlementSource,
  Tier,
} from "~/integrations/types";
import {
  getChunkedCredential,
  setChunkedCredential,
} from "~/integrations/auth/chunked";

import { getSupabaseClient } from "./client";
import { supabaseSession, supabaseSessionReady } from "./session";

const CACHE_SERVICE = "supabase.entitlements";
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
const FOCUS_REFRESH_MIN_GAP_MS = 30_000;

/**
 * Whether the last entitlement refresh reached Supabase. UI (e.g. the plan
 * badge) can read this to show an offline indicator. `offline-cached` means we
 * are serving a valid cached snapshot; `offline-uncached` means the refresh
 * failed with no usable cache, so the user has collapsed to the free tier.
 */
export type EntitlementSyncStatus = "online" | "offline-cached" | "offline-uncached";
const [entitlementSyncStatus, setEntitlementSyncStatus] =
  createSignal<EntitlementSyncStatus>("online");
export { entitlementSyncStatus };

export interface CachedSnapshot {
  fetchedAt: number;
  /** Raw RPC rows from `get_entitlements`. */
  rows: Array<{ plan_id?: string; feature_key: string; value: string }>;
  /** The plan id resolved at fetch time (for the tier label). */
  plan: Tier;
  /**
   * Highest wall clock observed while this snapshot was cached (stamped on
   * every read/write). `Date.now()` falling behind it means the system clock
   * was set backwards, so the snapshot can't be trusted against the TTL.
   * Optional — snapshots written before the field existed still load.
   */
  lastSeenWallClock?: number;
}

/**
 * TTL + clock-tamper check. Pure so it's unit-testable without keyring
 * mocks. `Date.now()` is UTC-epoch, so timezone/DST changes never trip
 * these guards — only actual system-clock jumps beyond the skew allowance.
 */
export function isSnapshotUsable(snapshot: CachedSnapshot, now: number): boolean {
  if (snapshot.fetchedAt > now + CLOCK_SKEW_MS) return false;
  if (
    snapshot.lastSeenWallClock !== undefined &&
    now < snapshot.lastSeenWallClock - CLOCK_SKEW_MS
  ) {
    return false;
  }
  return now - snapshot.fetchedAt < CACHE_TTL_MS;
}

function planFromRows(rows: CachedSnapshot["rows"]): Tier {
  // get_entitlements returns the resolved plan_id on every row since the
  // 20260706 migration. The dropbox-flag sniff below covers snapshots and
  // deployments predating it — delete the fallback once staging and prod
  // both run the new RPC and one release has shipped.
  const declared = rows[0]?.plan_id;
  if (declared === "free" || declared === "pro") return declared;
  const lookup = (key: string): boolean =>
    rows.find((r) => r.feature_key === key)?.value === "true";
  if (lookup("integrations.cloud.dropbox")) return "pro";
  return "free";
}

function buildSource(snapshot: CachedSnapshot): EntitlementSource {
  const index = new Map(snapshot.rows.map((r) => [r.feature_key, r.value]));
  const tier = snapshot.plan;
  return {
    current: () => tier,
    has(key: EntitlementKey): boolean {
      const value = index.get(key);
      if (value === undefined) {
        // Unknown key — Phase 7 ships the matrix in seed.sql; anything
        // not there is a developer error. Fail closed for paid features
        // (anything not on the free row) and open for clearly-local ones
        // (the free row marks them true). We can't tell without the
        // matrix, so default to false to avoid silent leakage of gated
        // features.
        return false;
      }
      return value === "true" || value === "unlimited";
    },
    reasonIfMissing(key: EntitlementKey) {
      const value = index.get(key);
      if (value === undefined) return "no-account";
      if (value === "false") return "wrong-tier";
      return undefined;
    },
  };
}

async function writeCache(userId: string, snapshot: CachedSnapshot): Promise<void> {
  await setChunkedCredential(
    CACHE_SERVICE,
    userId,
    JSON.stringify({ ...snapshot, lastSeenWallClock: Date.now() }),
  );
}

async function readCache(userId: string): Promise<CachedSnapshot | null> {
  // Chunked: the Pro snapshot of feature rows (JSON) exceeds Windows
  // Credential Manager's single-blob cap.
  const raw = await getChunkedCredential(CACHE_SERVICE, userId);
  if (!raw) return null;
  let snapshot: CachedSnapshot;
  try {
    snapshot = JSON.parse(raw) as CachedSnapshot;
  } catch {
    return null;
  }
  if (!isSnapshotUsable(snapshot, Date.now())) return null;
  // Re-persist so lastSeenWallClock advances to the time observed here —
  // a later backwards clock jump is then detectable.
  void writeCache(userId, snapshot).catch(() => undefined);
  return snapshot;
}

async function fetchEntitlements(): Promise<CachedSnapshot | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.rpc("get_entitlements");
  if (error || !data) return null;
  const rows = data as Array<{ plan_id?: string; feature_key: string; value: string }>;
  return {
    fetchedAt: Date.now(),
    rows,
    plan: planFromRows(rows),
  };
}

function isCurrentSessionUser(userId: string): boolean {
  return supabaseSession()?.user.id === userId;
}

async function refreshFor(userId: string): Promise<void> {
  const fresh = await fetchEntitlements();
  if (!isCurrentSessionUser(userId)) return;
  if (fresh) {
    setEntitlementSource(buildSource(fresh));
    setEntitlementSyncStatus("online");
    void writeCache(userId, fresh).catch(() => undefined);
    return;
  }
  // Refresh failed (offline / RPC error). Don't silently strip a paying
  // user of their plan: keep serving a usable cached snapshot. Only when
  // there is no usable cache do we fall through to the free stub — and in
  // that case make it visible rather than a silent downgrade.
  recordError(
    "entitlements-refresh",
    `get_entitlements failed for ${userId}; falling back to cache`,
  );
  const cached = await readCache(userId).catch(() => null);
  if (!isCurrentSessionUser(userId)) return;
  if (cached) {
    setEntitlementSource(buildSource(cached));
    setEntitlementSyncStatus("offline-cached");
  } else {
    // Toast only on the transition into the uncached state — the focus
    // refetch would otherwise re-toast every 30s while offline.
    const alreadyNotified = entitlementSyncStatus() === "offline-uncached";
    setEntitlementSyncStatus("offline-uncached");
    if (!alreadyNotified) {
      notifyError(
        "Couldn't verify your plan",
        "You appear to be offline. Some paid features may be locked until Typeward can reach your account again.",
      );
    }
  }
}

/**
 * Re-fetch entitlements for the current session user and swap the source.
 * No-op when signed out or Supabase isn't configured. Called from the
 * window-focus listener and the Settings → Account "Refresh plan" button.
 */
export async function refreshEntitlements(): Promise<void> {
  if (!getSupabaseClient()) return;
  const session = supabaseSession();
  if (!session) return;
  await refreshFor(session.user.id);
}

let focusListenerInstalled = false;

function installFocusRefresh(): void {
  if (focusListenerInstalled) return;
  focusListenerInstalled = true;
  // performance.now() is monotonic — a wall-clock jump can't wedge the throttle.
  let lastRunAt = -Infinity;
  window.addEventListener("focus", () => {
    const now = performance.now();
    if (now - lastRunAt < FOCUS_REFRESH_MIN_GAP_MS) return;
    lastRunAt = now;
    void refreshEntitlements();
  });
}

/**
 * Mount the source-swap effect. Called once at boot from App.tsx.
 *
 * The effect reacts to `supabaseSession()`:
 *   - Signed in → restore cache (instant) + background refresh + swap source.
 *   - Signed out → reset to stub.
 */
export function initSupabaseEntitlements(): void {
  installFocusRefresh();
  createRoot(() => {
    createEffect(() => {
      if (!supabaseSessionReady()) return;
      const session = supabaseSession();
      if (!session) {
        resetEntitlementSource();
        return;
      }
      const userId = session.user.id;
      resetEntitlementSource();

      // Restore cache first so the UI doesn't bounce while we fetch.
      void readCache(userId)
        .then((cached) => {
          if (!isCurrentSessionUser(userId)) return;
          if (cached) setEntitlementSource(buildSource(cached));
        })
        .catch(() => undefined);

      void refreshFor(userId);
    });
  });
}

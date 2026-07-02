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
 *
 * Cache TTL is 7 days; after that we collapse to free-tier and surface
 * an in-app banner the user can dismiss by going online.
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
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

interface CachedSnapshot {
  fetchedAt: number;
  /** Raw RPC rows from `get_entitlements`. */
  rows: Array<{ feature_key: string; value: string }>;
  /** The plan id resolved at fetch time (for the tier label). */
  plan: Tier;
}

function planFromRows(rows: CachedSnapshot["rows"]): Tier {
  // The plan isn't returned by get_entitlements directly; derive from the
  // presence of a Pro-only feature flag. Cheap and stable.
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

async function readCache(userId: string): Promise<CachedSnapshot | null> {
  // Chunked: the Pro snapshot of feature rows (JSON) exceeds Windows
  // Credential Manager's single-blob cap.
  const raw = await getChunkedCredential(CACHE_SERVICE, userId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedSnapshot;
  } catch {
    return null;
  }
}

async function writeCache(userId: string, snapshot: CachedSnapshot): Promise<void> {
  await setChunkedCredential(CACHE_SERVICE, userId, JSON.stringify(snapshot));
}

async function fetchEntitlements(): Promise<CachedSnapshot | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.rpc("get_entitlements");
  if (error || !data) return null;
  const rows = data as Array<{ feature_key: string; value: string }>;
  return {
    fetchedAt: Date.now(),
    rows,
    plan: planFromRows(rows),
  };
}

function isCurrentSessionUser(userId: string): boolean {
  return supabaseSession()?.user.id === userId;
}

/**
 * Mount the source-swap effect. Called once at boot from App.tsx.
 *
 * The effect reacts to `supabaseSession()`:
 *   - Signed in → restore cache (instant) + background refresh + swap source.
 *   - Signed out → reset to stub.
 */
export function initSupabaseEntitlements(): void {
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
      void readCache(userId).then((cached) => {
        if (!isCurrentSessionUser(userId)) return;
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          setEntitlementSource(buildSource(cached));
        }
      });

      // Then refresh.
      void fetchEntitlements().then(async (fresh) => {
        if (!isCurrentSessionUser(userId)) return;
        if (fresh) {
          setEntitlementSource(buildSource(fresh));
          setEntitlementSyncStatus("online");
          void writeCache(userId, fresh).catch(() => undefined);
          return;
        }
        // Refresh failed (offline / RPC error). Don't silently strip a paying
        // user of their plan: keep serving a within-TTL cached snapshot. Only
        // when there is no usable cache do we fall through to the free stub —
        // and in that case make it visible rather than a silent downgrade.
        recordError(
          "entitlements-refresh",
          `get_entitlements failed for ${userId}; falling back to cache`,
        );
        const cached = await readCache(userId);
        if (!isCurrentSessionUser(userId)) return;
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          setEntitlementSource(buildSource(cached));
          setEntitlementSyncStatus("offline-cached");
        } else {
          setEntitlementSyncStatus("offline-uncached");
          notifyError(
            "Couldn't verify your plan",
            "You appear to be offline. Some paid features may be locked until Typeward can reach your account again.",
          );
        }
      });
    });
  });
}

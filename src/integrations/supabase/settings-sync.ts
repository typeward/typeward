/**
 * Settings sync — app settings follow the signed-in user across devices.
 * FREE with an account; no entitlement key gates it.
 *
 * One `public.user_settings` row per synced key (RLS-scoped to the user).
 * Conflict policy is per-key last-write-wins ordered by the SERVER-side
 * `updated_at` — a DB trigger stamps it, so client clocks appear nowhere in
 * the protocol. A pass pushes locally-dirty keys first (an intentional local
 * change gets a fresh server stamp before the pull runs), then pulls and
 * applies every key whose server `updated_at` is newer than the last-seen
 * stamp recorded for that key in `<app_data>/settings-sync.json`.
 *
 * Triggers: session restore / sign-in (gated on `settingsLoaded()` — running
 * before settings.json hydrates would diff defaults against the server and
 * push garbage), window focus (30s min gap, the entitlements-source pattern),
 * and local changes to synced keys (debounced ~2s, only changed keys move).
 *
 * Offline-safe: a failed pass leaves the sync state untouched and the next
 * trigger retries — no toasts, never blocks the UI. Sign-out stops the engine
 * and keeps local settings as they are.
 */

import { batch, createEffect, createRoot } from "solid-js";

import * as ipc from "~/ipc";
import { sha256Hex } from "~/lib/hash";
import { recordError } from "~/lib/telemetry";
import { isPreviewWindow } from "~/lib/window-role";
import {
  PERSISTED_SETTING_KEYS,
  applyRemoteSettingValue,
  buildSettings,
  settingsLoaded,
  syncSettingsEnabled,
} from "~/stores/settings-store";

import { getSupabaseClient, type TypewardSupabaseClient } from "./client";
import type { Json } from "./database.types";
import { supabaseSession, supabaseSessionReady } from "./session";

const PUSH_DEBOUNCE_MS = 2_000;
const FOCUS_SYNC_MIN_GAP_MS = 30_000;
/** Sanity cap per value — a synced key is a preference, not a document. */
export const MAX_VALUE_JSON_CHARS = 64 * 1024;

/**
 * Machine-specific keys that must never leave (or land on) this device.
 * Everything in `PERSISTED_SETTING_KEYS` and NOT listed here syncs; the
 * drift-guard test fails when a new FieldSpec is neither synced nor listed,
 * so adding a persisted field forces a classification decision.
 */
export const SETTINGS_SYNC_DENYLIST: ReadonlySet<string> = new Set([
  // Filesystem path — machine-specific by definition.
  "projectsRoot",
  // Tool/binary availability: which of system TeX / the Tectonic sidecar /
  // texlive-wasm exists is per-machine (migrateCompileEngine is already
  // platform-dependent).
  "compileEngine",
  // Per-device first-run state.
  "onboarded",
  // Keyring-adjacent state plus machine-local references, denied as the one
  // blob the store round-trips: cloud.accounts (WebDAV hosts whose secrets
  // live in THIS machine's keyring), vcs.github.accountId (device-flow token
  // slot), references.* (localhost Zotero/BBT probes, Mendeley account +
  // redirectUri), ai.* (providers keyed to keyring API keys, localhost/LAN
  // Ollama URL), templates.recentTemplateIds (machine-local custom:<id>
  // template dirs under <app_data>), account.signedInEmail (device auth
  // mirror). Syncing account descriptors without their secrets would
  // manufacture phantom accounts that fail auth on the other device.
  "integrations",
  // Device identifier + per-device consent: privacy.installId is the random
  // per-install crash-report id (cloning it would merge Sentry installs
  // across machines) and privacy.shareCrashReports is per-device egress
  // consent that must not follow the account.
  "privacy",
  // References a theme JSON in this machine's <app_data>/themes/.
  "ui.activeCustomTheme",
  // The sync toggle itself — governs THIS device's participation.
  "sync.syncSettings",
]);
// Window geometry/layout and recent-file lists are pre-declared device-local
// categories, but nothing in settings.json carries them today (panel state
// lives in localStorage) — if such a field ever lands, it belongs above.

export function syncedSettingKeys(): string[] {
  return PERSISTED_SETTING_KEYS.filter((k) => !SETTINGS_SYNC_DENYLIST.has(k));
}

export interface RemoteRow {
  key: string;
  value: Json;
  updated_at: string;
}

/**
 * Keys with a recorded sync-state entry whose current local value no longer
 * matches the last-synced hash — i.e. changed on this device since the last
 * pass. Keys never synced are NOT dirty: on a fresh device the server copy
 * must win (that's the feature), and a key absent on the server seeds after
 * the pull instead.
 */
export function computeDirtyKeys(
  localHashes: Record<string, string>,
  state: Record<string, ipc.SyncKeyState>,
): string[] {
  return Object.keys(localHashes).filter((key) => {
    const seen = state[key];
    return seen !== undefined && seen.hash !== localHashes[key];
  });
}

/**
 * Server rows to apply: synced keys whose `updated_at` is newer than the
 * last-seen stamp (or never seen on this device). Equal stamps skip — that's
 * our own upsert echoing back. Stamps compare as parsed epochs with a
 * lexicographic tie-break so Postgres' microsecond precision (which
 * Date.parse truncates) still orders same-millisecond writes.
 */
export function selectRowsToApply(
  rows: RemoteRow[],
  state: Record<string, ipc.SyncKeyState>,
  syncedKeys: ReadonlySet<string>,
): RemoteRow[] {
  return rows.filter((row) => {
    if (!syncedKeys.has(row.key)) return false;
    const seen = state[row.key];
    if (!seen) return true;
    const remote = Date.parse(row.updated_at);
    const local = Date.parse(seen.seenUpdatedAt);
    if (Number.isFinite(remote) && Number.isFinite(local) && remote !== local) {
      return remote > local;
    }
    return row.updated_at > seen.seenUpdatedAt;
  });
}

/**
 * Everything one sync pass touches, injected so unit tests can run the full
 * pass against a mocked supabase client and in-memory state/store.
 */
export interface SyncPassIo {
  client: Pick<TypewardSupabaseClient, "from">;
  userId: string;
  loadState(): Promise<ipc.SettingsSyncState>;
  saveState(state: ipc.SettingsSyncState): Promise<void>;
  /** Current local value of every synced key, as canonical local JSON. */
  collectLocal(): Record<string, string>;
  /** Apply server rows through the store's hydrate/validate boundary. */
  applyRemote(rows: RemoteRow[]): void;
  /** One key's local JSON after an apply (post-validate re-serialization). */
  rereadLocal(key: string): string | undefined;
  /** False once the user signed out/switched or turned the toggle off. */
  isStillEligible(): boolean;
}

/** Keys under the size cap; oversized values are skipped with telemetry. */
function withinCap(keys: string[], local: Record<string, string>): string[] {
  return keys.filter((key) => {
    if (local[key].length <= MAX_VALUE_JSON_CHARS) return true;
    recordError("settings-sync", `skipping oversized synced value for ${key}`);
    return false;
  });
}

async function pushRows(
  io: SyncPassIo,
  keys: string[],
  local: Record<string, string>,
): Promise<Array<{ key: string; updated_at: string }>> {
  // JSON.parse of the canonical string detaches the pushed value from the
  // live signal objects. `updated_at` is deliberately omitted — the DB
  // trigger is the only writer of the stamp.
  const rows = keys.map((key) => ({
    user_id: io.userId,
    key,
    value: JSON.parse(local[key]) as Json,
  }));
  const { data, error } = await io.client
    .from("user_settings")
    .upsert(rows, { onConflict: "user_id,key" })
    .select("key,updated_at");
  if (error || !data) {
    throw new Error(error?.message ?? "user_settings upsert returned no rows");
  }
  return data;
}

/**
 * One full sync pass. Push-before-pull is the LWW correctness core: a dirty
 * local key gets a fresh server stamp before the pull, so the pull can't
 * clobber it with an older remote value, while a genuinely newer write from
 * another device still applies. Any thrown failure leaves the persisted sync
 * state exactly as the last successful step wrote it.
 */
export async function runSettingsSyncPass(io: SyncPassIo): Promise<void> {
  const file = await io.loadState();
  if (!io.isStillEligible()) return;
  const state: Record<string, ipc.SyncKeyState> = { ...(file[io.userId] ?? {}) };
  const persist = () => io.saveState({ ...file, [io.userId]: state });

  const local = io.collectLocal();
  const localHashes: Record<string, string> = {};
  for (const [key, json] of Object.entries(local)) {
    localHashes[key] = await sha256Hex(json);
  }

  // 1. Push locally-dirty keys first.
  const dirty = withinCap(computeDirtyKeys(localHashes, state), local);
  if (dirty.length > 0) {
    const stamps = await pushRows(io, dirty, local);
    if (!io.isStillEligible()) return;
    for (const stamp of stamps) {
      state[stamp.key] = { seenUpdatedAt: stamp.updated_at, hash: localHashes[stamp.key] };
    }
    // Persist immediately: if the pull below fails, the recorded stamps stop
    // the next pass from re-pushing (and re-stamping) unchanged values.
    await persist();
  }

  // 2. Pull and apply server-newer keys through the hydrate/validate boundary.
  const { data, error } = await io.client
    .from("user_settings")
    .select("key,value,updated_at")
    .eq("user_id", io.userId);
  if (error || !data) {
    throw new Error(error?.message ?? "user_settings select failed");
  }
  if (!io.isStillEligible()) return;
  const rows = data as RemoteRow[];
  let mutated = false;
  const toApply = selectRowsToApply(rows, state, new Set(Object.keys(local)));
  if (toApply.length > 0) {
    io.applyRemote(toApply);
    for (const row of toApply) {
      // Hash the post-validate local re-serialization, not the wire value:
      // jsonb normalizes key order and validation may clamp, so only the
      // local canonical form keeps dirty detection stable.
      const json = io.rereadLocal(row.key);
      state[row.key] = {
        seenUpdatedAt: row.updated_at,
        hash: json !== undefined ? await sha256Hex(json) : localHashes[row.key],
      };
      mutated = true;
    }
  }

  // 3. Seed keys this account has never synced anywhere (no local record, no
  //    server row). The first pass for a new user uploads the full synced set.
  const serverKeys = new Set(rows.map((r) => r.key));
  const seeds = withinCap(
    Object.keys(local).filter((key) => !state[key] && !serverKeys.has(key)),
    local,
  );
  if (seeds.length > 0) {
    const stamps = await pushRows(io, seeds, local);
    if (!io.isStillEligible()) return;
    for (const stamp of stamps) {
      state[stamp.key] = { seenUpdatedAt: stamp.updated_at, hash: localHashes[stamp.key] };
      mutated = true;
    }
  }

  if (mutated) await persist();
}

// ---------------------------------------------------------------------------
// Wiring: reactive triggers + single-flight around the pass above.

function valueAtPath(obj: unknown, key: string): unknown {
  let cursor: unknown = obj;
  for (const part of key.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Canonical local JSON of every synced key, via the store's serializers. */
function collectSyncedLocal(): Record<string, string> {
  const settings = buildSettings();
  const out: Record<string, string> = {};
  for (const key of syncedSettingKeys()) {
    const json = JSON.stringify(valueAtPath(settings, key));
    out[key] = json === undefined ? "null" : json;
  }
  return out;
}

function projectionJson(): string {
  return JSON.stringify(collectSyncedLocal());
}

let lastProjection: string | null = null;
let applyingRemote = false;

function applyRows(rows: RemoteRow[]): void {
  // The change effect fires synchronously while these hydrate; the flag plus
  // the lastProjection reset below keep an applied pull from scheduling a
  // push of its own values (the no-push-loop invariant). The settings-store
  // persistence effect still fires and writes settings.json, as intended.
  applyingRemote = true;
  try {
    batch(() => {
      for (const row of rows) {
        applyRemoteSettingValue(row.key, row.value);
      }
    });
  } finally {
    applyingRemote = false;
  }
  lastProjection = projectionJson();
}

function eligible(): boolean {
  return Boolean(
    !isPreviewWindow &&
      settingsLoaded() &&
      syncSettingsEnabled() &&
      supabaseSession() &&
      getSupabaseClient(),
  );
}

let running = false;
let queued = false;

/** Single-flight: passes never interleave; bursts collapse into one re-run. */
async function requestSyncPass(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    do {
      queued = false;
      await runOnce();
    } while (queued);
  } finally {
    running = false;
  }
}

async function runOnce(): Promise<void> {
  if (!eligible()) return;
  const client = getSupabaseClient();
  const session = supabaseSession();
  if (!client || !session) return;
  const userId = session.user.id;
  const io: SyncPassIo = {
    client,
    userId,
    loadState: () => ipc.loadSyncState(),
    saveState: (state) => ipc.saveSyncState(state),
    collectLocal: collectSyncedLocal,
    applyRemote: applyRows,
    rereadLocal: (key) => collectSyncedLocal()[key],
    isStillEligible: () =>
      supabaseSession()?.user.id === userId && syncSettingsEnabled(),
  };
  try {
    await runSettingsSyncPass(io);
  } catch (e) {
    // Offline / RPC failure: sync state stays at the last successful step and
    // the next trigger (focus, change, sign-in) retries. Silent by design —
    // settings sync must never toast or block.
    recordError("settings-sync", "sync pass failed; will retry on next trigger", e);
  }
}

let focusListenerInstalled = false;

function installFocusSync(): void {
  if (focusListenerInstalled) return;
  focusListenerInstalled = true;
  // performance.now() is monotonic — a wall-clock jump can't wedge the throttle.
  let lastRunAt = -Infinity;
  window.addEventListener("focus", () => {
    const now = performance.now();
    if (now - lastRunAt < FOCUS_SYNC_MIN_GAP_MS) return;
    lastRunAt = now;
    void requestSyncPass();
  });
}

let engineStarted = false;

/**
 * Mount the sync engine. Called once at boot from App.tsx's deferred supabase
 * block (so the supabase chunk stays off the boot path). No-op in the detached
 * preview window — it holds a read-only settings snapshot and must never push.
 */
export function initSettingsSync(): void {
  if (engineStarted) return;
  engineStarted = true;
  if (isPreviewWindow) return;
  installFocusSync();
  createRoot(() => {
    // Boot / sign-in / toggle-on → full pass. Keyed on the user id so token
    // refreshes (new session object, same user) don't re-kick.
    let lastKick: string | null = null;
    createEffect(() => {
      if (!supabaseSessionReady() || !settingsLoaded()) return;
      const userId = supabaseSession()?.user.id ?? null;
      const kick = userId !== null && syncSettingsEnabled() ? userId : null;
      if (kick !== null && kick !== lastKick) void requestSyncPass();
      lastKick = kick;
    });

    // Local change → debounced pass (it pushes only hash-dirty keys, so a
    // no-op re-render can't generate traffic).
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    createEffect(() => {
      const projection = projectionJson();
      if (!settingsLoaded()) return;
      if (applyingRemote) return;
      if (lastProjection === null) {
        // First run after hydration — the baseline, not a user change.
        lastProjection = projection;
        return;
      }
      if (projection === lastProjection) return;
      lastProjection = projection;
      if (!eligible()) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        pushTimer = null;
        void requestSyncPass();
      }, PUSH_DEBOUNCE_MS);
    });
  });
}

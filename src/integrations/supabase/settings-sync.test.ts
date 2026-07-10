import { describe, expect, it, vi } from "vitest";

import type * as ipcTypes from "~/ipc";

// Deterministic stand-in for the Web Crypto digest — the tests assert on
// hash *equality*, not hash values, so "h:<json>" is sufficient and keeps
// the suite off crypto.subtle (not guaranteed under jsdom).
vi.mock("~/lib/hash", () => ({
  sha256Hex: vi.fn((s: string) => Promise.resolve("h:" + s)),
}));
const telemetry = vi.hoisted(() => ({ recordError: vi.fn() }));
vi.mock("~/lib/telemetry", () => telemetry);

import { PERSISTED_SETTING_KEYS } from "~/stores/settings-store";

import type { Json } from "./database.types";
import {
  MAX_VALUE_JSON_CHARS,
  type RemoteRow,
  SETTINGS_SYNC_DENYLIST,
  type SyncPassIo,
  computeDirtyKeys,
  runSettingsSyncPass,
  selectRowsToApply,
  syncedSettingKeys,
} from "./settings-sync";

const h = (json: string) => "h:" + json;
/** Monotonic server stamps; `n` orders them. */
const T = (n: number) => new Date(Date.UTC(2026, 6, 9, 12, 0, 0, n)).toISOString();

// ---------------------------------------------------------------------------
// Key classification (the denylist drift guard).

describe("settings-sync key classification", () => {
  it("classifies every persisted settings key as synced or device-local", () => {
    // Adding a FieldSpec without deciding its sync fate must fail here —
    // same philosophy as FieldSpec owning both roundtrip sides.
    const persisted = new Set(PERSISTED_SETTING_KEYS);
    for (const denied of SETTINGS_SYNC_DENYLIST) {
      expect(
        persisted.has(denied),
        `denylisted key "${denied}" is not a persisted settings key`,
      ).toBe(true);
    }
    const synced = new Set(syncedSettingKeys());
    for (const key of persisted) {
      expect(
        synced.has(key) !== SETTINGS_SYNC_DENYLIST.has(key),
        `persisted key "${key}" must be classified exactly once`,
      ).toBe(true);
    }
  });

  it("keeps machine-specific keys off the wire", () => {
    const synced = new Set(syncedSettingKeys());
    for (const key of [
      "projectsRoot", // filesystem path
      "compileEngine", // per-machine tool availability
      "onboarded", // per-device first-run state
      "integrations", // keyring-adjacent accounts / localhost URLs / recents
      "privacy", // installId device identifier + per-device consent
      "ui.activeCustomTheme", // references this machine's <app_data>/themes/
      "sync.syncSettings", // the toggle itself
    ]) {
      expect(synced.has(key), `"${key}" must be device-local`).toBe(false);
    }
  });

  it("syncs the preference keys", () => {
    const synced = new Set(syncedSettingKeys());
    for (const key of [
      "theme",
      "accent",
      "editor",
      "ui.density",
      "workspace.defaultView",
      "workspace.spaces",
      "updates.checkAutomatically",
    ]) {
      expect(synced.has(key), `"${key}" should sync`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure merge pieces.

describe("computeDirtyKeys", () => {
  it("flags keys whose recorded hash no longer matches", () => {
    const dirty = computeDirtyKeys(
      { theme: h('"lamplight"'), accent: h('"violet-cyan"') },
      {
        theme: { seenUpdatedAt: T(1), hash: h('"daylight"') },
        accent: { seenUpdatedAt: T(1), hash: h('"violet-cyan"') },
      },
    );
    expect(dirty).toEqual(["theme"]);
  });

  it("does not treat never-synced keys as dirty", () => {
    // A fresh device must not push its defaults over the account's settings;
    // never-seen keys resolve via pull (server row exists) or seed (none).
    expect(computeDirtyKeys({ theme: h('"daylight"') }, {})).toEqual([]);
  });
});

describe("selectRowsToApply", () => {
  const synced = new Set(["theme", "accent"]);

  it("applies rows never seen on this device", () => {
    const rows: RemoteRow[] = [{ key: "theme", value: "lamplight", updated_at: T(5) }];
    expect(selectRowsToApply(rows, {}, synced)).toEqual(rows);
  });

  it("applies strictly newer rows and skips equal stamps (own-write echo)", () => {
    const state = {
      theme: { seenUpdatedAt: T(5), hash: h('"lamplight"') },
      accent: { seenUpdatedAt: T(5), hash: h('"violet-cyan"') },
    };
    const rows: RemoteRow[] = [
      { key: "theme", value: "paper", updated_at: T(6) },
      { key: "accent", value: "violet-cyan", updated_at: T(5) },
    ];
    expect(selectRowsToApply(rows, state, synced).map((r) => r.key)).toEqual(["theme"]);
  });

  it("skips rows older than the last-seen stamp", () => {
    const state = { theme: { seenUpdatedAt: T(5), hash: h('"x"') } };
    const rows: RemoteRow[] = [{ key: "theme", value: "aurora", updated_at: T(4) }];
    expect(selectRowsToApply(rows, state, synced)).toEqual([]);
  });

  it("filters keys outside the synced set (denylisted or unknown)", () => {
    const rows: RemoteRow[] = [
      { key: "privacy", value: { shareCrashReports: true }, updated_at: T(9) },
      { key: "some.future.key", value: 1, updated_at: T(9) },
    ];
    expect(selectRowsToApply(rows, {}, synced)).toEqual([]);
  });

  it("orders same-millisecond writes by the microsecond digits", () => {
    // Date.parse truncates Postgres' microsecond precision; the lexicographic
    // tie-break must still see .000200 as newer than .000100.
    const seen = "2026-07-09T12:00:00.000100+00:00";
    const state = { theme: { seenUpdatedAt: seen, hash: h('"x"') } };
    const newer: RemoteRow[] = [
      { key: "theme", value: "paper", updated_at: "2026-07-09T12:00:00.000200+00:00" },
    ];
    const older: RemoteRow[] = [
      { key: "theme", value: "paper", updated_at: "2026-07-09T12:00:00.000050+00:00" },
    ];
    expect(selectRowsToApply(newer, state, synced)).toEqual(newer);
    expect(selectRowsToApply(older, state, synced)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full pass against a mocked supabase client.

interface FakeRow {
  value: Json;
  updated_at: string;
}

function fakeClient(table: Map<string, FakeRow>, opts: { failUpsert?: boolean } = {}) {
  let stamp = 100;
  const upserted: string[][] = [];
  const client = {
    from(tableName: string) {
      expect(tableName).toBe("user_settings");
      return {
        upsert(
          rows: Array<{ user_id: string; key: string; value: Json }>,
          upsertOpts: { onConflict: string },
        ) {
          return {
            select(_cols: string) {
              if (opts.failUpsert) {
                return Promise.resolve({ data: null, error: { message: "offline" } });
              }
              expect(upsertOpts.onConflict).toBe("user_id,key");
              upserted.push(rows.map((r) => r.key));
              const data = rows.map((r) => {
                const updated_at = T(stamp++);
                table.set(r.key, { value: r.value, updated_at });
                return { key: r.key, updated_at };
              });
              return Promise.resolve({ data, error: null });
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              const data = [...table.entries()].map(([key, row]) => ({
                key,
                value: row.value,
                updated_at: row.updated_at,
              }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as SyncPassIo["client"], upserted };
}

function makeIo(args: {
  table: Map<string, FakeRow>;
  local: Record<string, string>;
  state?: ipcTypes.SettingsSyncState;
  failUpsert?: boolean;
  eligible?: () => boolean;
}) {
  const { client, upserted } = fakeClient(args.table, { failUpsert: args.failUpsert });
  const savedStates: ipcTypes.SettingsSyncState[] = [];
  const applied: string[] = [];
  const io: SyncPassIo = {
    client,
    userId: "user-1",
    loadState: async () => structuredClone(args.state ?? {}),
    saveState: async (s) => {
      savedStates.push(structuredClone(s));
    },
    collectLocal: () => ({ ...args.local }),
    applyRemote: (rows) => {
      for (const row of rows) {
        applied.push(row.key);
        args.local[row.key] = JSON.stringify(row.value);
      }
    },
    rereadLocal: (key) => args.local[key],
    isStillEligible: args.eligible ?? (() => true),
  };
  return { io, upserted, savedStates, applied };
}

describe("runSettingsSyncPass", () => {
  it("pushes only hash-dirty keys and records the returned server stamps", async () => {
    const table = new Map<string, FakeRow>([
      ["theme", { value: "daylight", updated_at: T(1) }],
      ["accent", { value: "violet-cyan", updated_at: T(1) }],
    ]);
    const local = { theme: '"lamplight"', accent: '"violet-cyan"' };
    const { io, upserted, savedStates, applied } = makeIo({
      table,
      local,
      state: {
        "user-1": {
          theme: { seenUpdatedAt: T(1), hash: h('"daylight"') },
          accent: { seenUpdatedAt: T(1), hash: h('"violet-cyan"') },
        },
      },
    });
    await runSettingsSyncPass(io);

    expect(upserted).toEqual([["theme"]]);
    expect(table.get("theme")?.value).toBe("lamplight");
    expect(applied).toEqual([]);
    const finalState = savedStates[savedStates.length - 1]["user-1"];
    expect(finalState.theme.hash).toBe(h('"lamplight"'));
    expect(finalState.theme.seenUpdatedAt).toBe(table.get("theme")?.updated_at);
  });

  it("gives a dirty local key precedence over a newer server row (push-before-pull)", async () => {
    // The server row is newer than our last-seen stamp AND we changed the key
    // locally: the push re-stamps our value, so the pull sees an equal stamp
    // and applies nothing — arrival-order LWW, the documented policy.
    const table = new Map<string, FakeRow>([
      ["theme", { value: "paper", updated_at: T(50) }],
    ]);
    const local = { theme: '"lamplight"' };
    const { io, savedStates, applied } = makeIo({
      table,
      local,
      state: { "user-1": { theme: { seenUpdatedAt: T(1), hash: h('"daylight"') } } },
    });
    await runSettingsSyncPass(io);

    expect(applied).toEqual([]);
    expect(table.get("theme")?.value).toBe("lamplight");
    expect(local.theme).toBe('"lamplight"');
    const finalState = savedStates[savedStates.length - 1]["user-1"];
    expect(finalState.theme.hash).toBe(h('"lamplight"'));
  });

  it("applies server-newer keys and hashes the post-apply local form", async () => {
    const table = new Map<string, FakeRow>([
      ["accent", { value: "ember", updated_at: T(9) }],
    ]);
    const local = { accent: '"violet-cyan"', theme: '"daylight"' };
    const { io, upserted, savedStates, applied } = makeIo({
      table,
      local,
      state: {
        "user-1": {
          accent: { seenUpdatedAt: T(2), hash: h('"violet-cyan"') },
          theme: { seenUpdatedAt: T(2), hash: h('"daylight"') },
        },
      },
    });
    await runSettingsSyncPass(io);

    expect(applied).toEqual(["accent"]);
    expect(local.accent).toBe('"ember"');
    expect(upserted).toEqual([]);
    const finalState = savedStates[savedStates.length - 1]["user-1"];
    expect(finalState.accent).toEqual({ seenUpdatedAt: T(9), hash: h('"ember"') });
    // theme untouched: no dirt, no newer row.
    expect(finalState.theme).toEqual({ seenUpdatedAt: T(2), hash: h('"daylight"') });
  });

  it("pulls the account's settings onto a fresh device instead of pushing defaults", async () => {
    // No sync-state at all (new install), server already has the user's keys:
    // the server must win — pushing local defaults here would clobber every
    // other device's preferences.
    const table = new Map<string, FakeRow>([
      ["theme", { value: "lamplight", updated_at: T(3) }],
    ]);
    const local = { theme: '"daylight"' };
    const { io, applied } = makeIo({ table, local });
    await runSettingsSyncPass(io);

    expect(applied).toEqual(["theme"]);
    expect(local.theme).toBe('"lamplight"');
    expect(table.get("theme")?.value).toBe("lamplight");
  });

  it("seeds keys that exist on neither side", async () => {
    const table = new Map<string, FakeRow>([
      ["theme", { value: "lamplight", updated_at: T(3) }],
    ]);
    const local = { theme: '"daylight"', accent: '"violet-cyan"' };
    const { io, upserted, savedStates } = makeIo({ table, local });
    await runSettingsSyncPass(io);

    // theme came from the server (never pushed); accent seeded up.
    expect(upserted).toEqual([["accent"]]);
    expect(table.get("accent")?.value).toBe("violet-cyan");
    const finalState = savedStates[savedStates.length - 1]["user-1"];
    expect(finalState.accent.hash).toBe(h('"violet-cyan"'));
    expect(finalState.accent.seenUpdatedAt).toBe(table.get("accent")?.updated_at);
  });

  it("skips values over the sanity cap", async () => {
    telemetry.recordError.mockClear();
    const huge = JSON.stringify("x".repeat(MAX_VALUE_JSON_CHARS + 1));
    const table = new Map<string, FakeRow>();
    const local = { "workspace.spaces": huge, theme: '"daylight"' };
    const { io, upserted } = makeIo({ table, local });
    await runSettingsSyncPass(io);

    expect(upserted).toEqual([["theme"]]);
    expect(table.has("workspace.spaces")).toBe(false);
    expect(telemetry.recordError).toHaveBeenCalledWith(
      "settings-sync",
      expect.stringContaining("workspace.spaces"),
    );
  });

  it("propagates a failed push without touching persisted state", async () => {
    const table = new Map<string, FakeRow>();
    const local = { theme: '"lamplight"' };
    const { io, savedStates } = makeIo({
      table,
      local,
      state: { "user-1": { theme: { seenUpdatedAt: T(1), hash: h('"daylight"') } } },
      failUpsert: true,
    });
    await expect(runSettingsSyncPass(io)).rejects.toThrow("offline");
    expect(savedStates).toEqual([]);
  });

  it("drops results once the session is no longer eligible", async () => {
    // Sign-out/account-switch mid-flight: the push may have landed, but no
    // local state is recorded and nothing is applied.
    const table = new Map<string, FakeRow>([
      ["accent", { value: "ember", updated_at: T(9) }],
    ]);
    const local = { theme: '"lamplight"', accent: '"violet-cyan"' };
    let calls = 0;
    const { io, savedStates, applied } = makeIo({
      table,
      local,
      state: { "user-1": { theme: { seenUpdatedAt: T(1), hash: h('"daylight"') } } },
      eligible: () => ++calls <= 1,
    });
    await runSettingsSyncPass(io);

    expect(applied).toEqual([]);
    expect(savedStates).toEqual([]);
  });

  it("keeps the sync-state file's other accounts intact", async () => {
    const table = new Map<string, FakeRow>();
    const local = { theme: '"daylight"' };
    const otherAccount = { theme: { seenUpdatedAt: T(7), hash: h('"paper"') } };
    const { io, savedStates } = makeIo({
      table,
      local,
      state: { "user-2": otherAccount },
    });
    await runSettingsSyncPass(io);

    const final = savedStates[savedStates.length - 1];
    expect(final["user-2"]).toEqual(otherAccount);
    expect(final["user-1"].theme.hash).toBe(h('"daylight"'));
  });
});

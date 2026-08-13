import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ipcTypes from "~/ipc";

// Isolated from settings-store.test.ts on purpose: that suite runs against the
// unmocked module, and a hoisted `vi.mock("~/ipc")` would change behavior for
// every test in the file. Module registries are per-file, so the persistence
// machinery gets its mocks here without leaking.
const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  recordError: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("~/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/ipc")>();
  return {
    ...actual,
    loadSettings: mocks.loadSettings,
    saveSettings: mocks.saveSettings,
  };
});
vi.mock("~/lib/telemetry", () => ({
  recordError: mocks.recordError,
}));
vi.mock("~/lib/toast", () => ({
  pendingToasts: () => [],
  notifyError: mocks.notifyError,
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
  errorText: (e: unknown) => String(e),
}));

const DEBOUNCE_MS = 250;
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const TIMEOUT_MS = 15_000;

type Store = typeof import("./settings-store");

function savedArg(i: number): ipcTypes.AppSettings {
  return mocks.saveSettings.mock.calls[i][0] as ipcTypes.AppSettings;
}

/**
 * Fresh module per test (the persistence effect lives in a module-scope
 * createRoot). loadSettings rejects (first-boot path), so after the load
 * settles the effect writes the defaults snapshot once; let it succeed so
 * `lastSavedJson` is seeded and each test starts from a clean store.
 */
async function bootStore(): Promise<Store> {
  vi.resetModules();
  const store = await import("./settings-store");
  for (let i = 0; i < 10 && !store.settingsLoaded(); i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(store.settingsLoaded()).toBe(true);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
  mocks.saveSettings.mockClear();
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  // The failure path (telemetry + toast + retry) is gated on Tauri IPC being
  // present so plain-browser dev and Vitest keep the old swallow behavior;
  // these tests exercise the Tauri branch.
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: () => {},
  };
  mocks.loadSettings.mockReset();
  mocks.saveSettings.mockReset();
  mocks.recordError.mockReset();
  mocks.notifyError.mockReset();
  mocks.loadSettings.mockRejectedValue(new Error("no settings.json"));
  mocks.saveSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("settings-store persistence", () => {
  it("persists a change once and stays quiet when clean", async () => {
    const store = await bootStore();

    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(savedArg(0).onboarded).toBe(true);

    await vi.advanceTimersByTimeAsync(RETRY_MS * 4);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(mocks.recordError).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  it("keeps a failed write dirty and retries it without a new change", async () => {
    const store = await bootStore();

    mocks.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(savedArg(0).onboarded).toBe(true);
    expect(mocks.recordError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
    expect(savedArg(1).onboarded).toBe(true);

    await vi.advanceTimersByTimeAsync(RETRY_MS * 4);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("toasts and records telemetry once per failure streak and re-arms after a success", async () => {
    const store = await bootStore();

    mocks.saveSettings
      .mockRejectedValueOnce(new Error("locked"))
      .mockRejectedValueOnce(new Error("locked"));
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
    expect(mocks.recordError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(3);

    mocks.saveSettings.mockRejectedValueOnce(new Error("locked again"));
    store.setUpdatesCheckAutomatically(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.notifyError).toHaveBeenCalledTimes(2);
    expect(mocks.recordError).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(5);
  });

  it("backs off exponentially to the 60s cap with one telemetry row for the streak", async () => {
    const store = await bootStore();

    mocks.saveSettings.mockRejectedValue(new Error("disk full"));
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);

    const delays = [
      RETRY_MS,
      RETRY_MS * 2,
      RETRY_MS * 4,
      RETRY_MS * 8,
      RETRY_MS * 16,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
    ];
    for (const delay of delays) {
      const before = mocks.saveSettings.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mocks.saveSettings).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.saveSettings).toHaveBeenCalledTimes(before + 1);
    }

    expect(mocks.recordError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
  });

  it("a fresh change during a failure streak resets the backoff", async () => {
    const store = await bootStore();

    mocks.saveSettings.mockRejectedValue(new Error("disk full"));
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(3);

    store.setUpdatesCheckAutomatically(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(5);

    expect(mocks.recordError).toHaveBeenCalledTimes(1);
  });

  it("a change made while a write is in flight wins over the stale retry", async () => {
    const store = await bootStore();

    let rejectA!: (e: unknown) => void;
    mocks.saveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(savedArg(0).updates?.checkAutomatically).toBe(true);

    store.setUpdatesCheckAutomatically(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);

    rejectA(new Error("disk full"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
    const retried = savedArg(1);
    expect(retried.onboarded).toBe(true);
    expect(retried.updates?.checkAutomatically).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_MS * 4);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("times out a hung save, releases the latch, and later changes persist", async () => {
    const store = await bootStore();

    mocks.saveSettings.mockImplementationOnce(() => new Promise<void>(() => {}));
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(mocks.recordError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.recordError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
    expect(savedArg(1).onboarded).toBe(true);

    store.setUpdatesCheckAutomatically(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(3);
    expect(savedArg(2).updates?.checkAutomatically).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(3);
    expect(mocks.recordError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
  });

  it("a late rejection after the timeout doesn't double-count the streak", async () => {
    const store = await bootStore();

    let rejectA!: (e: unknown) => void;
    mocks.saveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(mocks.recordError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);

    rejectA(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.recordError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
    expect(savedArg(1).onboarded).toBe(true);
  });

  it("a late success after the timeout re-persists the newer snapshot", async () => {
    const store = await bootStore();

    let resolveA!: () => void;
    mocks.saveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );
    store.setOnboarded(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);

    store.setUpdatesCheckAutomatically(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
    expect(savedArg(1).updates?.checkAutomatically).toBe(false);

    // The hung write settled last, so its stale snapshot is what's on disk
    // now — the store must notice and rewrite the newer one.
    resolveA();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(3);
    const rewritten = savedArg(2);
    expect(rewritten.onboarded).toBe(true);
    expect(rewritten.updates?.checkAutomatically).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(3);
  });
});

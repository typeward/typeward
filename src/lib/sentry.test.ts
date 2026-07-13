import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  init: vi.fn(),
  close: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@sentry/browser", () => ({
  init: h.init,
  close: h.close,
  captureException: h.captureException,
  captureMessage: h.captureMessage,
}));

// `initialized` is module state, so each test re-imports a fresh instance.
async function load(): Promise<typeof import("./sentry")> {
  vi.resetModules();
  return import("./sentry");
}

beforeEach(() => {
  h.init.mockReset();
  h.close.mockReset().mockResolvedValue(true);
  h.captureException.mockReset();
  h.captureMessage.mockReset();
});

describe("initSentry", () => {
  it("configures crash/error reporting only — no tracing, replay, or logs", async () => {
    const { initSentry } = await load();
    initSentry();
    expect(h.init).toHaveBeenCalledOnce();
    const options = h.init.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(options).sort()).toEqual(["dsn", "environment"]);
    // The "Share crash reports" toggle consents to exactly crash/error
    // events; any of these options would silently widen that egress.
    expect(options).not.toHaveProperty("integrations");
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("replaysSessionSampleRate");
    expect(options).not.toHaveProperty("replaysOnErrorSampleRate");
    expect(options).not.toHaveProperty("enableLogs");
  });

  it("is idempotent within a session", async () => {
    const { initSentry } = await load();
    initSentry();
    initSentry();
    expect(h.init).toHaveBeenCalledOnce();
  });
});

describe("shutdownSentry", () => {
  it("is a no-op when the client never initialized", async () => {
    const { shutdownSentry } = await load();
    shutdownSentry();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("flushes on opt-out and a later re-enable creates a fresh client", async () => {
    const { initSentry, shutdownSentry } = await load();
    initSentry();
    shutdownSentry();
    expect(h.close).toHaveBeenCalledWith(2000);
    initSentry();
    expect(h.init).toHaveBeenCalledTimes(2);
  });
});

describe("reportCrash", () => {
  it("drops ErrorBoundary crashes while reporting is off", async () => {
    const { reportCrash } = await load();
    reportCrash(new Error("boom"));
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it("tags ErrorBoundary crashes once enabled", async () => {
    const { initSentry, reportCrash } = await load();
    initSentry();
    const err = new Error("boom");
    reportCrash(err);
    expect(h.captureException).toHaveBeenCalledWith(err, {
      tags: { source: "app-error-boundary" },
    });
  });
});

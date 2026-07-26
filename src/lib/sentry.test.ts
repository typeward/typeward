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
    expect(Object.keys(options).sort()).toEqual([
      "beforeSend",
      "dsn",
      "environment",
      "sendDefaultPii",
    ]);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.beforeSend).toBeTypeOf("function");
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

describe("scrubPaths — egress path scrubber (TW-S2-05)", () => {
  it("removes the username from Windows and POSIX home paths", async () => {
    const { scrubPaths } = await load();
    expect(scrubPaths("read C:\\Users\\marek\\Documents\\main.tex")).not.toContain(
      "marek",
    );
    expect(scrubPaths("open /home/marek/proj/main.tex")).not.toContain("marek");
    expect(scrubPaths("open /Users/marek/proj/main.tex")).not.toContain("marek");
  });

  it("reduces a space-free Windows absolute path to its basename", async () => {
    const { scrubPaths } = await load();
    const out = scrubPaths("spawn C:\\tools\\bin\\pandoc.exe failed");
    expect(out).toContain("pandoc.exe");
    expect(out).not.toContain("tools");
  });

  it("leaves https URLs and path-free messages intact", async () => {
    const { scrubPaths } = await load();
    const u = "https://export.arxiv.org/api/query?id_list=2401.00001";
    expect(scrubPaths(u)).toBe(u);
    expect(scrubPaths("network timed out")).toBe("network timed out");
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

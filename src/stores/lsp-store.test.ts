import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "~/adapters/types";
import type { LanguageServerClient } from "~/lib/lsp/client";
import type { LspSession } from "~/lib/lsp/cm6";

// The store's whole job is orchestrating the async start pipeline (spawn ->
// staleness check -> initialize -> staleness check -> register), so we mock
// the two leaf modules and drive spawn resolution by hand via deferreds.
const h = vi.hoisted(() => ({
  startLsp: vi.fn(),
  wrap: vi.fn(),
  initSession: vi.fn(),
}));

vi.mock("~/lib/lsp/client", () => ({
  startLsp: h.startLsp,
  wrap: h.wrap,
}));
vi.mock("~/lib/lsp/cm6", () => ({
  initSession: h.initSession,
  pathToFileUri: (path: string) => path,
}));

import { findSession, startSession, stopAllSessions } from "./lsp-store";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTransport(serverId: string): LanguageServerClient {
  return {
    serverId,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

const projectA: Project = {
  rootPath: "/A",
  rootFile: "main.tex",
  format: "latex",
  name: "A",
};

const projectB: Project = {
  rootPath: "/B",
  rootFile: "main.tex",
  format: "latex",
  name: "B",
};

let startLspDeferreds: Deferred<LanguageServerClient>[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  startLspDeferreds = [];
  h.startLsp.mockImplementation(() => {
    const d = deferred<LanguageServerClient>();
    startLspDeferreds.push(d);
    return d.promise;
  });
  h.wrap.mockImplementation(() => ({
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(() => () => {}),
    stop: vi.fn().mockResolvedValue(undefined),
  }));
  h.initSession.mockImplementation(
    async (client: unknown, rootUri: string): Promise<LspSession> => ({
      client: client as LspSession["client"],
      rootUri,
      serverCapabilities: null,
      document: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    }),
  );
});

afterEach(async () => {
  await stopAllSessions();
});

describe("startSession", () => {
  it("starts a fresh server for a new project instead of adopting a stale in-flight start", async () => {
    let currentA = true;
    const startA = startSession("latex", projectA, () => currentA);
    expect(h.startLsp).toHaveBeenCalledTimes(1);

    currentA = false;
    const startB = startSession("latex", projectB, () => true);
    expect(h.startLsp).toHaveBeenCalledTimes(2);
    expect(h.startLsp).toHaveBeenNthCalledWith(2, {
      languageId: "latex",
      projectRoot: "/B",
    });

    const transportA = makeTransport("a");
    const transportB = makeTransport("b");
    startLspDeferreds[0]!.resolve(transportA);
    startLspDeferreds[1]!.resolve(transportB);

    const [sessionA, sessionB] = await Promise.all([startA, startB]);
    expect(sessionA).toBeNull();
    expect(transportA.stop).toHaveBeenCalled();
    expect(sessionB).not.toBeNull();
    expect(sessionB!.rootUri).toBe("/B");
    expect(findSession("latex")).toBe(sessionB);
  });

  it("dedupes concurrent starts for the same language and project", async () => {
    const first = startSession("latex", projectA);
    const second = startSession("latex", projectA);
    expect(h.startLsp).toHaveBeenCalledTimes(1);

    startLspDeferreds[0]!.resolve(makeTransport("a"));

    const [s1, s2] = await Promise.all([first, second]);
    expect(s1).not.toBeNull();
    expect(s2).toBe(s1);
    expect(findSession("latex")).toBe(s1);
  });

  it("returns the registered session without spawning again", async () => {
    const start = startSession("latex", projectA);
    startLspDeferreds[0]!.resolve(makeTransport("a"));
    const session = await start;

    const again = await startSession("latex", projectA);
    expect(again).toBe(session);
    expect(h.startLsp).toHaveBeenCalledTimes(1);
  });

  it("starts fresh when reopening a project whose abandoned start is still in flight (A -> B -> A)", async () => {
    let currentA1 = true;
    const startA1 = startSession("latex", projectA, () => currentA1);
    expect(h.startLsp).toHaveBeenCalledTimes(1);

    currentA1 = false;
    await stopAllSessions();
    let currentB = true;
    const startB = startSession("latex", projectB, () => currentB);
    expect(h.startLsp).toHaveBeenCalledTimes(2);

    currentB = false;
    await stopAllSessions();
    const startA2 = startSession("latex", projectA, () => true);
    expect(h.startLsp).toHaveBeenCalledTimes(3);
    expect(h.startLsp).toHaveBeenNthCalledWith(3, {
      languageId: "latex",
      projectRoot: "/A",
    });

    const transportA1 = makeTransport("a1");
    const transportB = makeTransport("b");
    startLspDeferreds[0]!.resolve(transportA1);
    startLspDeferreds[1]!.resolve(transportB);
    startLspDeferreds[2]!.resolve(makeTransport("a2"));

    const [sessionA1, sessionB, sessionA2] = await Promise.all([
      startA1,
      startB,
      startA2,
    ]);
    expect(sessionA1).toBeNull();
    expect(transportA1.stop).toHaveBeenCalled();
    expect(sessionB).toBeNull();
    expect(transportB.stop).toHaveBeenCalled();
    expect(sessionA2).not.toBeNull();
    expect(sessionA2!.rootUri).toBe("/A");
    expect(findSession("latex")).toBe(sessionA2);
  });

  it("keeps the reopened start's pending entry when the stale start's cleanup runs", async () => {
    let currentA1 = true;
    const startA1 = startSession("latex", projectA, () => currentA1);
    currentA1 = false;
    await stopAllSessions();

    const startA2 = startSession("latex", projectA, () => true);
    expect(h.startLsp).toHaveBeenCalledTimes(2);

    startLspDeferreds[0]!.resolve(makeTransport("a1"));
    expect(await startA1).toBeNull();

    const startA3 = startSession("latex", projectA, () => true);
    expect(h.startLsp).toHaveBeenCalledTimes(2);

    startLspDeferreds[1]!.resolve(makeTransport("a2"));
    const [sessionA2, sessionA3] = await Promise.all([startA2, startA3]);
    expect(sessionA2).not.toBeNull();
    expect(sessionA3).toBe(sessionA2);
    expect(findSession("latex")).toBe(sessionA2);
  });

  it("falls through to a fresh start when an adopted pending start self-cancels", async () => {
    let currentA1 = true;
    const startA1 = startSession("latex", projectA, () => currentA1);
    currentA1 = false;

    const startA2 = startSession("latex", projectA, () => true);
    expect(h.startLsp).toHaveBeenCalledTimes(1);

    startLspDeferreds[0]!.resolve(makeTransport("a1"));
    expect(await startA1).toBeNull();
    expect(h.startLsp).toHaveBeenCalledTimes(2);
    expect(h.startLsp).toHaveBeenNthCalledWith(2, {
      languageId: "latex",
      projectRoot: "/A",
    });

    startLspDeferreds[1]!.resolve(makeTransport("a2"));
    const sessionA2 = await startA2;
    expect(sessionA2).not.toBeNull();
    expect(sessionA2!.rootUri).toBe("/A");
    expect(findSession("latex")).toBe(sessionA2);
  });
});

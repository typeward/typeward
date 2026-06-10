import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine drives the Tauri fs plugin directly; stub it so the push/pull
// paths run in jsdom. `exists` is path-aware so we can exercise both the
// "local file present" and "new remote file" branches.
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async (p: string) => !p.includes("new-from-remote")),
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => new Uint8Array()),
  readTextFile: vi.fn(async () => ""),
  remove: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ mtime: new Date(0) })),
  writeFile: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {}),
}));

import type {
  CloudFsProvider,
  DeltaResult,
  RemoteFile,
} from "~/integrations/types";

import { SyncEngine } from "./engine";
import { clearSyncStatus, getSyncStatus } from "./sync-status";

const PROVIDER_ID = "dropbox";
const PROJECT_ID = "proj-1";
const ROOT_ID = "/remote/root";
const CACHE_ROOT = "/cache/proj-1";

function remoteFile(relPath: string, rev: string): RemoteFile {
  return { id: `id-${relPath}`, relPath, rev, modifiedAt: new Date(0).toISOString() };
}

function makeProvider(deltas: DeltaResult[]) {
  const queue = [...deltas];
  const provider = {
    id: PROVIDER_ID,
    category: "cloud",
    listRoots: vi.fn(async () => []),
    enumerateFiles: vi.fn(async () => ({ files: [], cursor: "c0" })),
    downloadFile: vi.fn(async () => {}),
    uploadFile: vi.fn(async (_rootId: string, relPath: string): Promise<RemoteFile> => {
      return remoteFile(relPath, "rev-uploaded");
    }),
    deleteRemoteFile: vi.fn(async () => {}),
    delta: vi.fn(async (): Promise<DeltaResult> => {
      return queue.shift() ?? { changes: [], nextCursor: "c-end" };
    }),
  } as unknown as CloudFsProvider & {
    uploadFile: ReturnType<typeof vi.fn>;
    downloadFile: ReturnType<typeof vi.fn>;
  };
  return provider;
}

function makeEngine(provider: CloudFsProvider): SyncEngine {
  return new SyncEngine(provider, {
    providerId: PROVIDER_ID,
    projectId: PROJECT_ID,
    rootId: ROOT_ID,
    projectsRoot: "/cache",
    cacheRoot: CACHE_ROOT,
    // Keep the poll far out so only the push debounce fires under fake timers.
    pollIntervalMs: 10_000_000,
  });
}

describe("SyncEngine push", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
  });

  it("uploads queued local saves after the debounce", async () => {
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    engine.queuePush(["sections/intro.tex"]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(provider.uploadFile).toHaveBeenCalledTimes(1);
    expect(provider.uploadFile).toHaveBeenCalledWith(
      ROOT_ID,
      "sections/intro.tex",
      expect.stringContaining("sections/intro.tex"),
    );
    engine.stop();
  });

  it("never pushes internal .typeward state", async () => {
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    engine.queuePush([".typeward/snapshots/intro.tex.snap"]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(provider.uploadFile).not.toHaveBeenCalled();
    engine.stop();
  });

  it("suppresses the echo of its own upload (no conflict, no download)", async () => {
    // Pull 1 is empty (initial tick). After we push, pull 2 echoes the file we
    // just uploaded with the same rev — the engine must skip it.
    const provider = makeProvider([
      { changes: [], nextCursor: "c0" },
      {
        changes: [{ kind: "modified", file: remoteFile("intro.tex", "rev-uploaded") }],
        nextCursor: "c1",
      },
    ]);
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    engine.queuePush(["intro.tex"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(provider.uploadFile).toHaveBeenCalledTimes(1);

    await engine.pullNow();

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).conflicts).toHaveLength(0);
    engine.stop();
  });

  it("still applies a genuine remote change (different rev)", async () => {
    const provider = makeProvider([
      { changes: [], nextCursor: "c0" },
      {
        changes: [
          { kind: "modified", file: remoteFile("new-from-remote.tex", "rev-remote") },
        ],
        nextCursor: "c1",
      },
    ]);
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    await engine.pullNow();

    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});

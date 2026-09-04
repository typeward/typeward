import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine drives the Tauri fs plugin directly; stub it so the push/pull
// paths run in jsdom. `exists` is path-aware so we can exercise both the
// "local file present" and "new remote file" branches.
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async (p: string) => !p.includes("new-from-remote")),
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => new TextEncoder().encode("local changed")),
  readTextFile: vi.fn(async () => ""),
  remove: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ mtime: new Date(0) })),
  writeFile: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {}),
}));

import {
  exists,
  readTextFile,
  remove,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type {
  CloudFsProvider,
  DeltaResult,
  RemoteFile,
} from "~/integrations/types";

import { SyncEngine } from "./engine";
import { clearSyncStatus, getSyncStatus, recordConflicts } from "./sync-status";

const PROVIDER_ID = "webdav";
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
    ensureFolder: vi.fn(async () => {}),
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
      // Never synced before, so there is no revision to make the PUT
      // conditional on — this is a plain create.
      undefined,
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

  it("detects concurrent edits by synced hash even when mtimes match", async () => {
    vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
      if (!String(path).includes("sync-state.json")) return "";
      return JSON.stringify({
        version: 1,
        files: {
          "intro.tex": {
            id: "id-intro.tex",
            relPath: "intro.tex",
            rev: "rev-base",
            hash: "00000000",
            size: 5,
            mtimeMs: 0,
          },
        },
      });
    });
    const provider = makeProvider([
      {
        changes: [{ kind: "modified", file: remoteFile("intro.tex", "rev-remote") }],
        nextCursor: "c1",
      },
    ]);
    const engine = makeEngine(provider);

    const result = await engine.pullNow();

    expect(result.conflicts).toEqual(["intro.tex"]);
    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(provider.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "intro.tex" }),
      expect.stringContaining(".conflict-"),
    );
    engine.stop();
  });

  it("preserves a locally edited file when the remote side deletes it", async () => {
    vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
      if (!String(path).includes("sync-state.json")) return "";
      return JSON.stringify({
        version: 1,
        files: {
          "intro.tex": {
            id: "id-intro.tex",
            relPath: "intro.tex",
            rev: "rev-base",
            hash: "00000000",
            size: 5,
            mtimeMs: 0,
          },
        },
      });
    });
    const provider = makeProvider([
      {
        changes: [{ kind: "removed", relPath: "intro.tex", id: "id-intro.tex" }],
        nextCursor: "c1",
      },
    ]);
    const engine = makeEngine(provider);

    const result = await engine.pullNow();

    expect(result.conflicts).toEqual(["intro.tex"]);
    const [conflictPath, conflictBytes] = vi.mocked(writeFile).mock.calls[0];
    expect(conflictPath).toContain(".conflict-");
    expect(ArrayBuffer.isView(conflictBytes)).toBe(true);
    expect(remove).toHaveBeenCalledWith(expect.stringContaining("intro.tex"));
    engine.stop();
  });
});

describe("SyncEngine pull cursor safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Earlier tests leave persistent implementations on the module-level fs
    // mocks (clearAllMocks doesn't restore them) — pin the defaults back.
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("new-from-remote"),
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
  });

  // A persisted cursor is content -> temp (writeTextFile) then rename -> cursor.
  // Reconstruct [finalPath, value] pairs from each committed rename so the
  // assertions can check both the destination and the value.
  const cursorWrites = () =>
    vi
      .mocked(rename)
      .mock.calls.filter(([, dst]) => String(dst).endsWith("cursor"))
      .map(([tmp, dst]) => {
        const w = vi
          .mocked(writeTextFile)
          .mock.calls.filter(([p]) => String(p) === String(tmp))
          .at(-1);
        return [String(dst), w ? String(w[1]) : undefined];
      });

  it("does not advance the cursor when applying a change fails", async () => {
    const page: DeltaResult = {
      changes: [{ kind: "modified", file: remoteFile("new-from-remote.tex", "rev-1") }],
      nextCursor: "c1",
    };
    const provider = makeProvider([page, page]);
    provider.downloadFile.mockRejectedValueOnce(new Error("network down"));
    const engine = makeEngine(provider);

    await expect(engine.pullNow()).rejects.toThrow("network down");
    expect(cursorWrites()).toHaveLength(0);

    const result = await engine.pullNow();

    expect(result.applied).toBe(1);
    expect(vi.mocked(provider.delta)).toHaveBeenNthCalledWith(2, ROOT_ID, undefined);
    expect(cursorWrites()).toEqual([[expect.stringContaining("cursor"), "c1"]]);
    await engine.stop();
  });

  it("skips an unsafe remote entry and still advances the cursor", async () => {
    const provider = makeProvider([
      {
        changes: [
          { kind: "modified", file: remoteFile("../evil.tex", "rev-evil") },
          { kind: "modified", file: remoteFile("new-from-remote.tex", "rev-1") },
        ],
        nextCursor: "c1",
      },
      { changes: [], nextCursor: "c2" },
    ]);
    const engine = makeEngine(provider);

    const result = await engine.pullNow();

    expect(result.applied).toBe(1);
    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(cursorWrites()).toEqual([[expect.stringContaining("cursor"), "c1"]]);

    await engine.pullNow();

    expect(vi.mocked(provider.delta)).toHaveBeenNthCalledWith(2, ROOT_ID, "c1");
    await engine.stop();
  });
});

describe("SyncEngine push batch retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("new-from-remote"),
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
  });

  it("still uploads items after a mid-batch failure and retries only the failed one", async () => {
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    let failed = false;
    provider.uploadFile.mockImplementation(
      async (_rootId: string, relPath: string): Promise<RemoteFile> => {
        if (relPath === "b.tex" && !failed) {
          failed = true;
          throw new Error("upload failed");
        }
        return remoteFile(relPath, "rev-uploaded");
      },
    );
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    engine.queuePush(["a.tex", "b.tex", "c.tex"]);
    await vi.advanceTimersByTimeAsync(2_000);
    // recordSyncedFile's SHA-256 digest resolves on the real thread pool,
    // which fake-timer advances don't deterministically drain — chain an
    // empty pull through runExclusive as a barrier so the in-flight push
    // pass has fully settled before asserting.
    await engine.pullNow();

    expect(provider.uploadFile.mock.calls.map((c) => c[1])).toEqual([
      "a.tex",
      "b.tex",
      "c.tex",
    ]);

    await vi.advanceTimersByTimeAsync(20_000);
    await engine.pullNow();

    expect(provider.uploadFile.mock.calls.map((c) => c[1])).toEqual([
      "a.tex",
      "b.tex",
      "c.tex",
      "b.tex",
    ]);
    await engine.stop();
  });

  it("retries a failed remote deletion without blocking other queued files", async () => {
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("gone.tex"),
    );
    vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
      if (!String(path).includes("sync-state.json")) return "";
      return JSON.stringify({
        version: 1,
        files: {
          "gone.tex": {
            id: "id-gone.tex",
            relPath: "gone.tex",
            rev: "rev-base",
            hash: "00000000",
            size: 5,
            mtimeMs: 0,
          },
        },
      });
    });
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    vi.mocked(provider.deleteRemoteFile).mockRejectedValueOnce(new Error("delete failed"));
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    engine.queuePush(["gone.tex", "kept.tex"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await engine.pullNow();

    expect(provider.deleteRemoteFile).toHaveBeenCalledTimes(1);
    expect(provider.uploadFile.mock.calls.map((c) => c[1])).toEqual(["kept.tex"]);

    await vi.advanceTimersByTimeAsync(20_000);
    await engine.pullNow();

    expect(provider.deleteRemoteFile).toHaveBeenCalledTimes(2);
    expect(provider.uploadFile.mock.calls.map((c) => c[1])).toEqual(["kept.tex"]);
    await engine.stop();
  });
});

describe("SyncEngine pull salvage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("new-from-remote"),
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
    vi.mocked(stat).mockImplementation(async () => ({ mtime: new Date(0) }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
  });

  // A persisted cursor is content -> temp (writeTextFile) then rename -> cursor.
  // Reconstruct [finalPath, value] pairs from each committed rename so the
  // assertions can check both the destination and the value.
  const cursorWrites = () =>
    vi
      .mocked(rename)
      .mock.calls.filter(([, dst]) => String(dst).endsWith("cursor"))
      .map(([tmp, dst]) => {
        const w = vi
          .mocked(writeTextFile)
          .mock.calls.filter(([p]) => String(p) === String(tmp))
          .at(-1);
        return [String(dst), w ? String(w[1]) : undefined];
      });
  const lastSyncStateWrite = () => {
    // A persisted manifest is content -> temp (writeTextFile) then rename ->
    // sync-state.json. Find the last committed rename, then read the content
    // that was written to its temp source.
    const commit = vi
      .mocked(rename)
      .mock.calls.filter(([, dst]) => String(dst).endsWith("sync-state.json"))
      .at(-1);
    if (!commit) return undefined;
    const tmp = String(commit[0]);
    const write = vi
      .mocked(writeTextFile)
      .mock.calls.filter(([p]) => String(p) === tmp)
      .at(-1);
    return write
      ? (JSON.parse(String(write[1])) as {
          pendingRetries?: Record<string, { relPath: string; reason: string }>;
        })
      : undefined;
  };

  it("salvages a poison page after repeated failures and retries the entry on later polls", async () => {
    const page: DeltaResult = {
      changes: [
        { kind: "modified", file: remoteFile("aux.tex", "rev-poison") },
        { kind: "modified", file: remoteFile("new-from-remote.tex", "rev-1") },
      ],
      nextCursor: "c1",
    };
    const provider = makeProvider([]);
    vi.mocked(provider.delta).mockImplementation(
      async (_root: string, cursor: string | undefined): Promise<DeltaResult> =>
        cursor === undefined ? page : { changes: [], nextCursor: "c-end" },
    );
    let auxWritable = false;
    provider.downloadFile.mockImplementation(async (file: RemoteFile) => {
      if (file.relPath === "aux.tex" && !auxWritable) {
        throw new Error("cannot create aux.tex");
      }
    });
    const engine = makeEngine(provider);
    await engine.start();
    // start()'s initial tick is failed attempt 1 (swallowed by the tick).
    await vi.advanceTimersByTimeAsync(1);

    await expect(engine.pullNow()).rejects.toThrow("cannot create aux.tex");
    await expect(engine.pullNow()).rejects.toThrow("cannot create aux.tex");
    expect(cursorWrites()).toHaveLength(0);

    const salvaged = await engine.pullNow();

    expect(salvaged.applied).toBe(1);
    expect(cursorWrites()).toEqual([[expect.stringContaining("cursor"), "c1"]]);
    expect(lastSyncStateWrite()?.pendingRetries?.["aux.tex"]).toMatchObject({
      relPath: "aux.tex",
      reason: "cannot create aux.tex",
    });
    const status = getSyncStatus(PROVIDER_ID, PROJECT_ID);
    expect(status.phase).toBe("error");
    expect(status.message).toContain("1 file");
    expect(status.message).toContain("aux.tex");

    auxWritable = true;
    const retried = await engine.pullNow();

    expect(retried.applied).toBe(1);
    expect(lastSyncStateWrite()?.pendingRetries ?? {}).toEqual({});
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).phase).toBe("idle");
    await engine.stop();
  });

  it("keeps a still-failing pending retry visible instead of reporting idle", async () => {
    const page: DeltaResult = {
      changes: [{ kind: "modified", file: remoteFile("aux.tex", "rev-poison") }],
      nextCursor: "c1",
    };
    const provider = makeProvider([]);
    vi.mocked(provider.delta).mockImplementation(
      async (_root: string, cursor: string | undefined): Promise<DeltaResult> =>
        cursor === undefined ? page : { changes: [], nextCursor: "c-end" },
    );
    provider.downloadFile.mockImplementation(async (file: RemoteFile) => {
      if (file.relPath === "aux.tex") throw new Error("cannot create aux.tex");
    });
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    await expect(engine.pullNow()).rejects.toThrow();
    await expect(engine.pullNow()).rejects.toThrow();
    await engine.pullNow();
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).phase).toBe("error");

    // Next poll retries the entry, fails again, and must stay visible.
    await engine.pullNow();

    expect(lastSyncStateWrite()?.pendingRetries?.["aux.tex"]).toBeDefined();
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).phase).toBe("error");
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).message).toContain("aux.tex");
    await engine.stop();
  });
});

describe("SyncEngine conflict retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("new-from-remote"),
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
    vi.mocked(stat).mockImplementation(async () => ({ mtime: new Date(0) }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
  });

  it("keeps unresolved conflicts across a clean pull pass (merge, not replace)", async () => {
    vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
      if (!String(path).includes("sync-state.json")) return "";
      return JSON.stringify({
        version: 1,
        files: {
          "intro.tex": {
            id: "id-intro.tex",
            relPath: "intro.tex",
            rev: "rev-base",
            hash: "00000000",
            size: 5,
            mtimeMs: 0,
          },
        },
      });
    });
    const provider = makeProvider([
      {
        changes: [{ kind: "modified", file: remoteFile("intro.tex", "rev-remote") }],
        nextCursor: "c1",
      },
      { changes: [], nextCursor: "c2" },
    ]);
    const engine = makeEngine(provider);

    const first = await engine.pullNow();
    expect(first.conflicts).toEqual(["intro.tex"]);
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).conflicts).toEqual(["intro.tex"]);

    const second = await engine.pullNow();
    expect(second.conflicts).toEqual([]);
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).conflicts).toEqual(["intro.tex"]);
    await engine.stop();
  });

  it("dedupes re-reported conflicts by path", () => {
    recordConflicts(PROVIDER_ID, PROJECT_ID, ["intro.tex"]);
    recordConflicts(PROVIDER_ID, PROJECT_ID, ["intro.tex", "other.tex"]);
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).conflicts).toEqual([
      "intro.tex",
      "other.tex",
    ]);
  });
});

describe("SyncEngine local-wins replay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("new-from-remote"),
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
    vi.mocked(stat).mockImplementation(async () => ({ mtime: new Date(0) }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
  });

  it("does not re-mint a sidecar on a replayed page and still pushes the local winner", async () => {
    // Local file is newer than the remote change and there's no synced state,
    // so the mtime heuristic picks local as the winner.
    vi.mocked(stat).mockImplementation(async () => ({ mtime: new Date(5_000) }) as never);
    const conflictChange = {
      kind: "modified" as const,
      file: { ...remoteFile("intro.tex", "rev-remote"), modifiedAt: new Date(1_000).toISOString() },
    };
    const page: DeltaResult = { changes: [conflictChange], nextCursor: "c1" };
    const provider = makeProvider([page, page, { changes: [], nextCursor: "c2" }]);
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    // start()'s tick consumed the first page (local wins → sidecar + queuePush);
    // this replays the identical page, as after a failed sibling entry.
    const replay = await engine.pullNow();

    expect(replay.conflicts).toEqual([]);
    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(String(provider.downloadFile.mock.calls[0][1])).toContain(".conflict-");
    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).conflicts).toEqual(["intro.tex"]);

    // The debounced push still uploads the local content that won.
    await vi.advanceTimersByTimeAsync(2_000);
    await engine.pullNow();

    expect(provider.uploadFile.mock.calls.map((c) => c[1])).toEqual(["intro.tex"]);
    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    await engine.stop();
  });
});

describe("SyncEngine sync-state load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSyncStatus(PROVIDER_ID, PROJECT_ID);
    vi.clearAllMocks();
    // These tests override the fs mocks; restore the factory defaults for the
    // rest of the suite (clearAllMocks resets calls, not implementations).
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => !String(p).includes("new-from-remote"),
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
  });

  it("does not start on a wiped baseline when an existing manifest fails to read", async () => {
    // The manifest exists, but a transient read error hits it — the baseline
    // must be preserved, not laundered into an empty (whole-project re-sync)
    // state.
    vi.mocked(exists).mockImplementation(async () => true);
    vi.mocked(readTextFile).mockImplementation(async (p: string | URL) => {
      if (String(p).includes("sync-state")) throw new Error("EIO: transient");
      return "";
    });
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    const engine = makeEngine(provider);
    await engine.start();

    // Backed out with an error/offline badge rather than proceeding.
    expect(["error", "offline"]).toContain(
      getSyncStatus(PROVIDER_ID, PROJECT_ID).phase,
    );
    // Engine is not running, so a queued push is a no-op — nothing syncs on a
    // lost baseline.
    engine.queuePush(["a.tex"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(provider.uploadFile).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("does not start when an existing cursor fails to read", async () => {
    // The cursor is the other half of the sync baseline: an undefined cursor
    // makes the poll-and-diff provider emit zero deletions, resurrecting
    // remotely-deleted files. An existing-but-unreadable cursor must back out,
    // not launder to undefined.
    vi.mocked(exists).mockImplementation(async () => true);
    vi.mocked(readTextFile).mockImplementation(async (p: string | URL) => {
      if (String(p).includes("cursor")) throw new Error("EIO: transient");
      return "";
    });
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    const engine = makeEngine(provider);
    await engine.start();

    expect(["error", "offline"]).toContain(
      getSyncStatus(PROVIDER_ID, PROJECT_ID).phase,
    );
    engine.queuePush(["a.tex"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(provider.uploadFile).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("also refuses to start on a corrupt (unparseable) existing manifest", async () => {
    vi.mocked(exists).mockImplementation(async () => true);
    vi.mocked(readTextFile).mockImplementation(async (p: string | URL) =>
      String(p).includes("sync-state") ? "{ not json" : "",
    );
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    const engine = makeEngine(provider);
    await engine.start();

    expect(["error", "offline"]).toContain(
      getSyncStatus(PROVIDER_ID, PROJECT_ID).phase,
    );
    await engine.stop();
  });

  it("starts fresh (empty state) when the manifest is simply absent", async () => {
    vi.mocked(exists).mockImplementation(async (p: string | URL) =>
      String(p).includes("sync-state") ? false : true,
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
    const provider = makeProvider([{ changes: [], nextCursor: "c0" }]);
    const engine = makeEngine(provider);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(getSyncStatus(PROVIDER_ID, PROJECT_ID).phase).not.toBe("error");
    // A first-run engine syncs normally.
    engine.queuePush(["a.tex"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(provider.uploadFile).toHaveBeenCalledTimes(1);
    await engine.stop();
  });
});

describe("SyncEngine provider state directory", () => {
  // The real WebDAV id. Its colon is illegal in a Win32 path component, so
  // spelling it into a directory name failed every cloud project open there
  // with os error 123 at the first cursor write.
  const WEBDAV_ID = "webdav:me@example.com@dav.example.com";
  const SAFE_DIR = `${CACHE_ROOT}/.typeward/integrations/webdav%3Ame@example.com@dav.example.com`;
  const LEGACY_DIR = `${CACHE_ROOT}/.typeward/integrations/${WEBDAV_ID}`;

  function webdavEngine(): SyncEngine {
    return new SyncEngine(makeProvider([]), {
      providerId: WEBDAV_ID,
      projectId: PROJECT_ID,
      rootId: ROOT_ID,
      projectsRoot: "/cache",
      cacheRoot: CACHE_ROOT,
      pollIntervalMs: 10_000_000,
    });
  }

  afterEach(() => {
    vi.mocked(exists).mockImplementation(async (p: string | URL) =>
      !String(p).includes("new-from-remote"),
    );
    vi.clearAllMocks();
  });

  it("writes provider state to a path Win32 accepts", async () => {
    vi.mocked(exists).mockImplementation(async () => false);
    await webdavEngine().seedFromRemote();

    const written = vi.mocked(writeTextFile).mock.calls.map((c) => String(c[0]));
    expect(written.length).toBeGreaterThan(0);
    for (const path of written) {
      expect(path.startsWith(SAFE_DIR)).toBe(true);
      // The drive letter is the only colon a Windows path may carry.
      expect(path.replace(/^[A-Za-z]:/, "")).not.toContain(":");
    }
    expect(vi.mocked(rename).mock.calls.at(-1)?.[1]).toBe(`${SAFE_DIR}/cursor`);
  });

  it("adopts a state directory left under the unescaped id", async () => {
    // macOS and Linux accept the raw id, so installs that already synced there
    // hold their cursor and manifest under it. Reading past them would look
    // like a first run and force a destructive whole-project re-sync.
    vi.mocked(exists).mockImplementation(async (p: string | URL) => String(p) === LEGACY_DIR);
    await webdavEngine().seedFromRemote();

    expect(vi.mocked(rename).mock.calls[0]).toEqual([LEGACY_DIR, SAFE_DIR]);
  });

  it("leaves the directory alone once the escaped one exists", async () => {
    vi.mocked(exists).mockImplementation(
      async (p: string | URL) => String(p) === LEGACY_DIR || String(p) === SAFE_DIR,
    );
    vi.mocked(readTextFile).mockImplementation(async () => "");
    await webdavEngine().seedFromRemote();

    expect(vi.mocked(rename).mock.calls).not.toContainEqual([LEGACY_DIR, SAFE_DIR]);
  });
});

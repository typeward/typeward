import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  // Mutable stand-in for editor-store's active project so persistence tests can
  // simulate a project switch between scheduling a save and flushing it.
  project: { current: null as { rootPath: string } | null },
  // Mutable stand-in for the profile identity Rust mints at startup.
  profile: { localId: "meId", displayName: "Me" },
}));

vi.mock("~/ipc", () => ({
  readProjectTextFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
  listReviewShards: vi.fn(),
}));

vi.mock("~/stores/editor-store", () => ({
  activeFile: vi.fn(() => null),
  project: vi.fn(() => h.project.current),
}));

vi.mock("~/stores/settings-store", () => ({
  profile: vi.fn(() => ({ displayName: h.profile.displayName, email: "", affiliation: "" })),
  profileLocalId: vi.fn(() => h.profile.localId),
}));

vi.mock("~/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

vi.mock("~/stores/notifications-store", () => ({
  pushNotification: vi.fn(),
}));

vi.mock("~/lib/telemetry", () => ({
  recordError: vi.fn(),
}));

import {
  allThreads,
  threadsForFile,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  openCommentThreadCount,
  openTodoThreads,
  openTodoThreadCount,
  loadThreads,
  reloadThreadsFromDisk,
  flushPendingReviewSave,
  flushAndResetThreads,
  resetThreads,
  _resetForTests,
} from "~/stores/review-store";
import { createThread } from "~/lib/reviews/types";
import type { CommentThread } from "~/lib/reviews/types";
import type { ReviewShard } from "~/lib/reviews/shard";
import * as ipc from "~/ipc";
import { notifyError } from "~/lib/toast";
import { pushNotification } from "~/stores/notifications-store";
import { recordError } from "~/lib/telemetry";

const readProjectTextFile = vi.mocked(ipc.readProjectTextFile);
const writeProjectTextFile = vi.mocked(ipc.writeProjectTextFile);
const listReviewShards = vi.mocked(ipc.listReviewShards);

const ME = { id: "meId", name: "Me" };
const ALICE = { id: "aliceId", name: "Alice" };

const MY_SHARD = ".typeward/reviews/meId.json";
const ALICE_SHARD = ".typeward/reviews/aliceId.json";

function shard(
  authorId: string,
  authorName: string,
  parts: Partial<Omit<ReviewShard, "authorId" | "authorName" | "schema">> = {},
): string {
  return JSON.stringify({
    schema: 1,
    authorId,
    authorName,
    threads: parts.threads ?? [],
    replies: parts.replies ?? {},
    patches: parts.patches ?? {},
  });
}

/** Serve a set of shards to the store's load path, keyed by rel path. */
function serveShards(files: Record<string, string>): void {
  listReviewShards.mockResolvedValue(
    Object.keys(files).map((p) => p.replace(".typeward/reviews/", "").replace(".json", "")),
  );
  readProjectTextFile.mockImplementation(async (_root: string, rel: string) => {
    const found = files[rel];
    if (found === undefined) throw new Error("os error 2: no such file");
    return found;
  });
}

/** The shard object the store last wrote. */
function lastWrittenShard(): ReviewShard {
  const calls = writeProjectTextFile.mock.calls;
  return JSON.parse(calls[calls.length - 1][2] as string) as ReviewShard;
}

describe("review-store", () => {
  beforeEach(() => {
    h.profile.localId = "meId";
    h.profile.displayName = "Me";
    _resetForTests();
  });

  it("starts empty", () => {
    expect(allThreads()).toEqual([]);
  });

  it("addThread appends a thread", () => {
    const t = createThread("main.tex", 0, 10, "hello", ME, "Root");
    addThread(t);
    expect(allThreads()).toHaveLength(1);
    expect(allThreads()[0].id).toBe(t.id);
  });

  it("threadsForFile filters by relPath", () => {
    addThread(createThread("a.tex", 0, 5, "aaa", ME, "A"));
    addThread(createThread("b.tex", 0, 5, "bbb", ME, "B"));
    expect(threadsForFile("a.tex")).toHaveLength(1);
    expect(threadsForFile("b.tex")).toHaveLength(1);
    expect(threadsForFile("c.tex")).toHaveLength(0);
  });

  it("addReplyToThread appends a reply", () => {
    const t = createThread("main.tex", 0, 10, "hello", ME, "Root");
    addThread(t);
    addReplyToThread(t.id, ALICE, "Reply");
    expect(allThreads()[0].comments).toHaveLength(2);
    expect(allThreads()[0].comments[1].authorId).toBe("aliceId");
  });

  it("resolveThreadById + reopenThreadById toggle status", () => {
    const t = createThread("main.tex", 0, 10, "hello", ME, "Root");
    addThread(t);
    resolveThreadById(t.id);
    expect(allThreads()[0].status).toBe("resolved");
    reopenThreadById(t.id);
    expect(allThreads()[0].status).toBe("open");
  });

  it("removeThread deletes a thread", () => {
    const t = createThread("main.tex", 0, 10, "hello", ME, "Root");
    addThread(t);
    removeThread(t.id);
    expect(allThreads()).toHaveLength(0);
  });

  it("count helpers split open threads by kind", () => {
    addThread(createThread("main.tex", 0, 5, "c1", ME, "C", "comment"));
    addThread(createThread("main.tex", 6, 9, "c2", ME, "C"));
    const todo = createThread("main.tex", 10, 13, "t1", ME, "T", "todo");
    addThread(todo);

    expect(openCommentThreadCount()).toBe(2);
    expect(openTodoThreadCount()).toBe(1);
    expect(openTodoThreads().map((t) => t.id)).toEqual([todo.id]);

    // Resolving a TODO drops it from both the todo list and its count.
    resolveThreadById(todo.id);
    expect(openTodoThreadCount()).toBe(0);
    expect(openCommentThreadCount()).toBe(2);
  });
});

describe("review-store persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readProjectTextFile.mockReset();
    writeProjectTextFile.mockReset();
    listReviewShards.mockReset();
    writeProjectTextFile.mockResolvedValue(undefined as never);
    listReviewShards.mockResolvedValue([]);
    vi.mocked(notifyError).mockReset();
    vi.mocked(pushNotification).mockReset();
    vi.mocked(recordError).mockReset();
    h.profile.localId = "meId";
    h.profile.displayName = "Me";
    h.project.current = { rootPath: "/proj/a" };
    _resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failed read of OUR shard stays read-only — a mutation does NOT overwrite it", async () => {
    // A real read failure (permission/lock), NOT not-found. Our threads exist on
    // disk but failed to load; persisting the empty in-memory list would wipe them.
    listReviewShards.mockResolvedValue(["meId"]);
    readProjectTextFile.mockRejectedValue(new Error("permission denied (os error 5)"));
    await loadThreads();

    expect(recordError).toHaveBeenCalledWith(
      "reviews-load",
      expect.stringContaining("meId"),
      expect.anything(),
    );

    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("a project with no shards yet is writable — mutations persist after the debounce", async () => {
    await loadThreads();
    expect(allThreads()).toEqual([]);

    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));
    expect(writeProjectTextFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    const [root, rel] = writeProjectTextFile.mock.calls[0];
    expect(root).toBe("/proj/a");
    expect(rel).toBe(MY_SHARD);
    expect(lastWrittenShard().threads).toHaveLength(1);
  });

  it("without an identity the store loads but refuses to write", async () => {
    // Rust mints the id at startup; until it reaches the renderer there is no
    // shard name to write to, and an empty one would collide with every other
    // install that has not settled either.
    h.profile.localId = "";
    const t = createThread("main.tex", 0, 5, "hi", ALICE, "From Alice");
    serveShards({ [ALICE_SHARD]: shard("aliceId", "Alice", { threads: [t] }) });

    await loadThreads();
    expect(allThreads()).toHaveLength(1);

    resolveThreadById(t.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();

    // Reading is unaffected: a collaborator's later comment still arrives.
    const second = createThread("main.tex", 6, 9, "more", ALICE, "And this");
    serveShards({ [ALICE_SHARD]: shard("aliceId", "Alice", { threads: [t, second] }) });
    await reloadThreadsFromDisk();
    expect(allThreads()).toHaveLength(2);
  });

  it("merges every shard in the project into one thread list", async () => {
    const mine = createThread("main.tex", 0, 5, "mine", ME, "Mine");
    const hers = createThread("main.tex", 6, 9, "hers", ALICE, "Hers");
    serveShards({
      [MY_SHARD]: shard("meId", "Me", { threads: [mine] }),
      [ALICE_SHARD]: shard("aliceId", "Alice", { threads: [hers] }),
    });

    await loadThreads();
    expect(allThreads().map((t) => t.id).sort()).toEqual([mine.id, hers.id].sort());
  });

  it("a reply to someone else's thread lands in OUR shard, never in theirs", async () => {
    const hers = createThread("main.tex", 0, 5, "hers", ALICE, "Hers");
    serveShards({ [ALICE_SHARD]: shard("aliceId", "Alice", { threads: [hers] }) });
    await loadThreads();

    addReplyToThread(hers.id, ME, "My reply");
    await vi.advanceTimersByTimeAsync(1_500);

    // Only our own shard is ever written.
    expect(writeProjectTextFile.mock.calls.every((c) => c[1] === MY_SHARD)).toBe(true);
    const written = lastWrittenShard();
    // Her thread is not copied into our file; only our comment on it is.
    expect(written.threads).toHaveLength(0);
    expect(written.replies[hers.id]).toHaveLength(1);
    expect(written.replies[hers.id][0].body).toBe("My reply");
  });

  it("resolving someone else's thread is recorded as a patch in our shard", async () => {
    const hers = createThread("main.tex", 0, 5, "hers", ALICE, "Hers");
    serveShards({ [ALICE_SHARD]: shard("aliceId", "Alice", { threads: [hers] }) });
    await loadThreads();

    resolveThreadById(hers.id);
    await vi.advanceTimersByTimeAsync(1_500);

    const written = lastWrittenShard();
    expect(written.patches[hers.id].status).toBe("resolved");
    expect(written.threads).toHaveLength(0);
  });

  it("deleting someone else's thread leaves a tombstone that survives a reload", async () => {
    const hers = createThread("main.tex", 0, 5, "hers", ALICE, "Hers");
    const aliceFile = shard("aliceId", "Alice", { threads: [hers] });
    serveShards({ [ALICE_SHARD]: aliceFile });
    await loadThreads();

    removeThread(hers.id);
    await vi.advanceTimersByTimeAsync(1_500);
    const written = lastWrittenShard();
    expect(written.patches[hers.id].deleted).toBe(true);

    // Her shard still holds the thread; without the tombstone the next merge
    // would bring it straight back.
    serveShards({ [ALICE_SHARD]: aliceFile, [MY_SHARD]: JSON.stringify(written) });
    await loadThreads();
    expect(allThreads()).toHaveLength(0);
  });

  it("our own edits are not clobbered by re-reading our own shard on a reload", async () => {
    // The watcher fires on our OWN write too. Re-merging must use memory for our
    // shard, or a save-then-reload race could undo what was just typed.
    serveShards({});
    await loadThreads();
    const t = createThread("main.tex", 0, 5, "mine", ME, "Mine");
    addThread(t);

    await reloadThreadsFromDisk();
    expect(allThreads().map((x) => x.id)).toEqual([t.id]);
  });

  it("a reload announces a collaborator's new thread and adopts it", async () => {
    serveShards({});
    await loadThreads();

    const hers = createThread("main.tex", 0, 5, "hers", ALICE, "Please cite this");
    serveShards({ [ALICE_SHARD]: shard("aliceId", "Alice", { threads: [hers] }) });
    await reloadThreadsFromDisk();

    expect(allThreads().map((t) => t.id)).toEqual([hers.id]);
    expect(pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("Alice"),
        key: `review:${hers.id}`,
      }),
    );
  });

  it("a reload does not announce our own comments coming back off disk", async () => {
    const mine = createThread("main.tex", 0, 5, "mine", ME, "Mine");
    serveShards({ [MY_SHARD]: shard("meId", "Me", { threads: [mine] }) });
    await loadThreads();
    vi.mocked(pushNotification).mockReset();

    await reloadThreadsFromDisk();
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it("a collaborator's reply to our thread is announced", async () => {
    const mine = createThread("main.tex", 0, 5, "mine", ME, "Mine");
    serveShards({ [MY_SHARD]: shard("meId", "Me", { threads: [mine] }) });
    await loadThreads();
    vi.mocked(pushNotification).mockReset();

    serveShards({
      [MY_SHARD]: shard("meId", "Me", { threads: [mine] }),
      [ALICE_SHARD]: shard("aliceId", "Alice", {
        replies: {
          [mine.id]: [
            {
              id: "reply1",
              author: "Alice",
              authorId: "aliceId",
              body: "Agreed",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }),
    });
    await reloadThreadsFromDisk();

    expect(allThreads()[0].comments).toHaveLength(2);
    expect(pushNotification).toHaveBeenCalledTimes(1);
  });

  it("saves are debounced — rapid mutations coalesce into one write", async () => {
    await loadThreads();

    addThread(createThread("main.tex", 0, 5, "a", ME, "A"));
    await vi.advanceTimersByTimeAsync(500);
    addThread(createThread("main.tex", 6, 9, "b", ME, "B"));
    await vi.advanceTimersByTimeAsync(500);
    addThread(createThread("main.tex", 10, 13, "c", ME, "C"));

    // Only the final quiet period should trigger a single write.
    expect(writeProjectTextFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(lastWrittenShard().threads).toHaveLength(3);
  });

  it("flushPendingReviewSave writes to the project captured at schedule time, not the current one", async () => {
    await loadThreads();

    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));
    // Simulate a project switch after the save was scheduled but before it fired.
    h.project.current = { rootPath: "/proj/b" };

    await flushPendingReviewSave();

    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(writeProjectTextFile.mock.calls[0][0]).toBe("/proj/a");

    // The flushed timer must not also fire and produce a second (cross-)write.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
  });

  it("a debounced timer that fires after a project switch refuses to cross-write", async () => {
    await loadThreads();

    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));
    // Switch project without flushing; the pending timer must not write to B.
    h.project.current = { rootPath: "/proj/b" };
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("resetThreads cancels a pending save and re-arms read-only", async () => {
    await loadThreads();
    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));

    resetThreads();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();

    // Read-only again: a mutation without a fresh load must not schedule a write.
    addThread(createThread("main.tex", 0, 5, "again", ME, "Root"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("flushAndResetThreads skips the stale reset when another project loads during the flush", async () => {
    await loadThreads();
    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));

    // Make the flush's write hang so the reopened editor can load underneath it.
    let releaseWrite!: () => void;
    writeProjectTextFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    const stale = flushAndResetThreads();

    // The reopened editor's open path: reset, then load project B's threads.
    resetThreads();
    h.project.current = { rootPath: "/proj/b" };
    const threadB: CommentThread = createThread("b.tex", 0, 5, "bee", ME, "B");
    serveShards({ [MY_SHARD]: shard("meId", "Me", { threads: [threadB] }) });
    await loadThreads();
    expect(allThreads()).toHaveLength(1);

    releaseWrite();
    await stale;

    // The stale reset must not have wiped B's threads...
    expect(allThreads().map((t) => t.id)).toEqual([threadB.id]);

    // ...nor re-armed read-only: a mutation in B still persists.
    addThread(createThread("b.tex", 6, 9, "more", ME, "B2"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(2);
    const [root] = writeProjectTextFile.mock.calls[1];
    expect(root).toBe("/proj/b");
    expect(lastWrittenShard().threads).toHaveLength(2);
  });

  it("flushAndResetThreads flushes to the closed project and resets when nothing interleaves", async () => {
    await loadThreads();
    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));

    await flushAndResetThreads();

    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(writeProjectTextFile.mock.calls[0][0]).toBe("/proj/a");
    expect(allThreads()).toEqual([]);

    // Read-only re-armed: a mutation without a fresh load must not persist.
    addThread(createThread("main.tex", 0, 5, "again", ME, "Root"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
  });

  it("a write failure surfaces a toast and retries via the debounce", async () => {
    await loadThreads();
    writeProjectTextFile.mockRejectedValue(new Error("disk full"));

    addThread(createThread("main.tex", 0, 5, "hello", ME, "Root"));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(
      "reviews-save",
      expect.stringContaining("meId.json"),
      expect.anything(),
    );

    // The failed save re-arms the debounce; a second attempt fires later.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(2);
    // Only one toast per project despite the repeated failure.
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  // Mutable stand-in for editor-store's active project so persistence tests can
  // simulate a project switch between scheduling a save and flushing it.
  project: { current: null as { rootPath: string } | null },
}));

vi.mock("~/ipc", () => ({
  readProjectTextFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

vi.mock("~/stores/editor-store", () => ({
  activeFile: vi.fn(() => null),
  project: vi.fn(() => h.project.current),
}));

vi.mock("~/lib/toast", () => ({
  notifyError: vi.fn(),
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
  flushPendingReviewSave,
  resetThreads,
  _resetForTests,
} from "~/stores/review-store";
import { createThread } from "~/lib/reviews/types";
import * as ipc from "~/ipc";
import { notifyError } from "~/lib/toast";
import { recordError } from "~/lib/telemetry";

const readProjectTextFile = vi.mocked(ipc.readProjectTextFile);
const writeProjectTextFile = vi.mocked(ipc.writeProjectTextFile);

describe("review-store", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("starts empty", () => {
    expect(allThreads()).toEqual([]);
  });

  it("addThread appends a thread", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    expect(allThreads()).toHaveLength(1);
    expect(allThreads()[0].id).toBe(t.id);
  });

  it("threadsForFile filters by relPath", () => {
    addThread(createThread("a.tex", 0, 5, "aaa", "Alice", "A"));
    addThread(createThread("b.tex", 0, 5, "bbb", "Alice", "B"));
    expect(threadsForFile("a.tex")).toHaveLength(1);
    expect(threadsForFile("b.tex")).toHaveLength(1);
    expect(threadsForFile("c.tex")).toHaveLength(0);
  });

  it("addReplyToThread appends a reply", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    addReplyToThread(t.id, "Bob", "Reply");
    expect(allThreads()[0].comments).toHaveLength(2);
  });

  it("resolveThreadById + reopenThreadById toggle status", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    resolveThreadById(t.id);
    expect(allThreads()[0].status).toBe("resolved");
    reopenThreadById(t.id);
    expect(allThreads()[0].status).toBe("open");
  });

  it("removeThread deletes a thread", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    removeThread(t.id);
    expect(allThreads()).toHaveLength(0);
  });

  it("count helpers split open threads by kind", () => {
    addThread(createThread("main.tex", 0, 5, "c1", "Alice", "C", "comment"));
    addThread(createThread("main.tex", 6, 9, "c2", "Alice", "C"));
    const todo = createThread("main.tex", 10, 13, "t1", "Alice", "T", "todo");
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
    writeProjectTextFile.mockResolvedValue(undefined as never);
    vi.mocked(notifyError).mockReset();
    vi.mocked(recordError).mockReset();
    h.project.current = { rootPath: "/proj/a" };
    _resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failed load stays read-only — a subsequent mutation does NOT overwrite the sidecar", async () => {
    // A real read failure (permission/lock), NOT not-found. Threads may exist on
    // disk but failed to load; persisting the empty in-memory list would wipe them.
    readProjectTextFile.mockRejectedValue(new Error("permission denied (os error 5)"));
    await loadThreads();

    expect(recordError).toHaveBeenCalledWith(
      "reviews-load",
      expect.stringContaining("comments.json"),
      expect.anything(),
    );

    // The store must not have laundered the failure into an empty writable slate.
    addThread(createThread("main.tex", 0, 5, "hello", "Alice", "Root"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("a not-found load is writable — mutations persist after the debounce", async () => {
    readProjectTextFile.mockRejectedValue(new Error("os error 2: no such file"));
    await loadThreads();
    expect(allThreads()).toEqual([]);

    addThread(createThread("main.tex", 0, 5, "hello", "Alice", "Root"));
    expect(writeProjectTextFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    const [root, rel, data] = writeProjectTextFile.mock.calls[0];
    expect(root).toBe("/proj/a");
    expect(rel).toBe(".typeward/reviews/comments.json");
    expect(JSON.parse(data as string)).toHaveLength(1);
  });

  it("a successful load populates threads and is writable", async () => {
    const existing = [createThread("main.tex", 0, 5, "hello", "Alice", "Root")];
    readProjectTextFile.mockResolvedValue(JSON.stringify(existing));
    await loadThreads();
    expect(allThreads()).toHaveLength(1);

    resolveThreadById(existing[0].id);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
  });

  it("saves are debounced — rapid mutations coalesce into one write", async () => {
    readProjectTextFile.mockRejectedValue(new Error("os error 2"));
    await loadThreads();

    addThread(createThread("main.tex", 0, 5, "a", "Alice", "A"));
    await vi.advanceTimersByTimeAsync(500);
    addThread(createThread("main.tex", 6, 9, "b", "Alice", "B"));
    await vi.advanceTimersByTimeAsync(500);
    addThread(createThread("main.tex", 10, 13, "c", "Alice", "C"));

    // Only the final quiet period should trigger a single write.
    expect(writeProjectTextFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeProjectTextFile.mock.calls[0][2] as string)).toHaveLength(3);
  });

  it("flushPendingReviewSave writes to the project captured at schedule time, not the current one", async () => {
    readProjectTextFile.mockRejectedValue(new Error("os error 2"));
    await loadThreads();

    addThread(createThread("main.tex", 0, 5, "hello", "Alice", "Root"));
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
    readProjectTextFile.mockRejectedValue(new Error("os error 2"));
    await loadThreads();

    addThread(createThread("main.tex", 0, 5, "hello", "Alice", "Root"));
    // Switch project without flushing; the pending timer must not write to B.
    h.project.current = { rootPath: "/proj/b" };
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("resetThreads cancels a pending save and re-arms read-only", async () => {
    readProjectTextFile.mockRejectedValue(new Error("os error 2"));
    await loadThreads();
    addThread(createThread("main.tex", 0, 5, "hello", "Alice", "Root"));

    resetThreads();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();

    // Read-only again: a mutation without a fresh load must not schedule a write.
    addThread(createThread("main.tex", 0, 5, "again", "Alice", "Root"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("a write failure surfaces a toast and retries via the debounce", async () => {
    readProjectTextFile.mockRejectedValue(new Error("os error 2"));
    await loadThreads();
    writeProjectTextFile.mockRejectedValue(new Error("disk full"));

    addThread(createThread("main.tex", 0, 5, "hello", "Alice", "Root"));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(
      "reviews-save",
      expect.stringContaining("comments.json"),
      expect.anything(),
    );

    // The failed save re-arms the debounce; a second attempt fires later.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeProjectTextFile).toHaveBeenCalledTimes(2);
    // Only one toast per project despite the repeated failure.
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/ipc", () => ({
  readProjectTextFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

vi.mock("~/stores/editor-store", () => ({
  activeFile: vi.fn(() => null),
  project: vi.fn(() => null),
}));

import {
  allThreads,
  threadsForFile,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  _resetForTests,
} from "~/stores/review-store";
import { createThread } from "~/lib/reviews/types";

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
});

import { describe, it, expect } from "vitest";
import { createThread, addReply, resolveThread, reopenThread } from "~/lib/reviews/types";
import { recoverThreads } from "~/lib/reviews/recovery";

const ALICE = { id: "aliceId", name: "Alice" };
const BOB = { id: "bobId", name: "Bob" };

describe("review types helpers", () => {
  it("createThread produces a valid thread with one root comment", () => {
    const t = createThread("main.tex", 10, 50, "some anchor text here", ALICE, "Fix this");
    expect(t.id).toBeTruthy();
    expect(t.fileRelPath).toBe("main.tex");
    expect(t.fromOffset).toBe(10);
    expect(t.toOffset).toBe(50);
    expect(t.anchorText).toBe("some anchor text here");
    expect(t.status).toBe("open");
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0].author).toBe("Alice");
    expect(t.comments[0].body).toBe("Fix this");
  });

  it("anchorText is truncated to 80 chars", () => {
    const long = "x".repeat(200);
    const t = createThread("main.tex", 0, 200, long, ALICE, "Too long");
    expect(t.anchorText).toHaveLength(80);
  });

  it("addReply appends a comment immutably", () => {
    const t = createThread("main.tex", 0, 10, "text", ALICE, "Root");
    const t2 = addReply(t, BOB, "Reply");
    expect(t2.comments).toHaveLength(2);
    expect(t2.comments[1].author).toBe("Bob");
    expect(t.comments).toHaveLength(1);
  });

  it("resolveThread / reopenThread toggle status", () => {
    const t = createThread("main.tex", 0, 10, "text", ALICE, "Root");
    expect(resolveThread(t).status).toBe("resolved");
    expect(reopenThread(resolveThread(t)).status).toBe("open");
  });
});

describe("recoverThreads", () => {
  const makeThread = (from: number, to: number, anchor: string) =>
    createThread("main.tex", from, to, anchor, ALICE, "Comment");

  it("exact match — offsets still valid", () => {
    const content = "Hello world, this is a test document.";
    const t = makeThread(6, 11, "world");
    const results = recoverThreads([t], content, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("exact");
    expect(results[0].fromOffset).toBe(6);
    expect(results[0].toOffset).toBe(11);
  });

  it("fuzzy match — offsets shifted but text found", () => {
    const t = makeThread(6, 11, "world");
    const newContent = "INSERTED Hello world, this is a test document.";
    const results = recoverThreads([t], newContent, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("fuzzy");
    expect(results[0].fromOffset).toBe(15);
    expect(results[0].toOffset).toBe(20);
  });

  it("orphan — text no longer in document", () => {
    const t = makeThread(0, 5, "DELETED");
    const content = "Hello world, completely different.";
    const results = recoverThreads([t], content, "main.tex");
    expect(results[0].recoveryStatus).toBe("orphaned");
  });

  it("orphan — text appears multiple times (ambiguous)", () => {
    // Offsets point to a stale position (100+ beyond content length) so exact
    // match fails, then fuzzy search finds "the" at multiple positions and
    // cannot resolve to a unique location — orphaned.
    const t = makeThread(100, 103, "the");
    const content = "the cat and the dog and the fish";
    const results = recoverThreads([t], content, "main.tex");
    expect(results[0].recoveryStatus).toBe("orphaned");
  });

  it("filters threads to the requested file only", () => {
    const t1 = makeThread(0, 5, "Hello");
    const t2 = createThread("other.tex", 0, 5, "Other", ALICE, "Nope");
    const results = recoverThreads([t1, t2], "Hello world", "main.tex");
    expect(results).toHaveLength(1);
  });

  it("fuzzy fallback to first 40 chars when full anchorText fails", () => {
    const anchor = "a]b".repeat(30);
    const t = makeThread(0, 90, anchor);
    const partial = anchor.slice(0, 40) + "XXXX_DIFFERENT_ENDING";
    const results = recoverThreads([t], partial, "main.tex");
    expect(results[0].recoveryStatus).toBe("fuzzy");
    expect(results[0].fromOffset).toBe(0);
  });
});

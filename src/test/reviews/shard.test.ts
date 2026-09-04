import { describe, it, expect } from "vitest";

import { buildShard, mergeShards, parseShard, type ReviewShard } from "~/lib/reviews/shard";
import { createThread, type Comment, type CommentThread } from "~/lib/reviews/types";

const ME = { id: "meId", name: "Me" };
const ALICE = { id: "aliceId", name: "Alice" };

const T0 = "2026-08-20T10:00:00.000Z";
const T1 = "2026-08-20T11:00:00.000Z";
const T2 = "2026-08-20T12:00:00.000Z";

function threadAt(
  author: typeof ME,
  createdAt: string,
  overrides: Partial<CommentThread> = {},
): CommentThread {
  return {
    ...createThread("main.tex", 0, 5, "anchor", author, "Body"),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function shardOf(
  author: typeof ME,
  parts: Partial<Omit<ReviewShard, "schema" | "authorId" | "authorName">> = {},
): ReviewShard {
  return {
    schema: 1,
    authorId: author.id,
    authorName: author.name,
    threads: parts.threads ?? [],
    replies: parts.replies ?? {},
    patches: parts.patches ?? {},
  };
}

function reply(id: string, author: typeof ME, createdAt: string, body = "Reply"): Comment {
  return { id, author: author.name, authorId: author.id, body, createdAt };
}

describe("mergeShards", () => {
  it("unions threads from every shard", () => {
    const mine = threadAt(ME, T0);
    const hers = threadAt(ALICE, T1);
    const merged = mergeShards([shardOf(ME, { threads: [mine] }), shardOf(ALICE, { threads: [hers] })]);
    expect(merged.map((t) => t.id)).toEqual([mine.id, hers.id]);
  });

  it("is order-independent, so two machines see the same list", () => {
    const mine = threadAt(ME, T0);
    const hers = threadAt(ALICE, T1);
    const a = shardOf(ME, { threads: [mine] });
    const b = shardOf(ALICE, { threads: [hers] });
    expect(mergeShards([a, b])).toEqual(mergeShards([b, a]));
  });

  it("folds a collaborator's reply into the thread it belongs to", () => {
    const mine = threadAt(ME, T0);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { replies: { [mine.id]: [reply("r1", ALICE, T1)] } }),
    ]);
    expect(merged[0].comments).toHaveLength(2);
    expect(merged[0].comments[1].authorId).toBe(ALICE.id);
  });

  it("keeps the root comment first even when a reply carries an earlier timestamp", () => {
    // Two machines' clocks are not in sync. Sorting purely by timestamp would
    // promote the reply to root and silently reattribute the whole thread.
    const mine = threadAt(ME, T1);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { replies: { [mine.id]: [reply("r1", ALICE, T0)] } }),
    ]);
    expect(merged[0].comments[0].authorId).toBe(ME.id);
    expect(merged[0].comments[0].body).toBe("Body");
  });

  it("drops a duplicated reply rather than showing it twice", () => {
    const mine = threadAt(ME, T0);
    const dupe = reply("r1", ALICE, T1);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine], replies: { [mine.id]: [dupe] } }),
      shardOf(ALICE, { replies: { [mine.id]: [dupe] } }),
    ]);
    expect(merged[0].comments).toHaveLength(2);
  });

  it("lets a newer patch resolve a thread its owner has not touched since", () => {
    const mine = threadAt(ME, T0);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { patches: { [mine.id]: { at: T1, status: "resolved" } } }),
    ]);
    expect(merged[0].status).toBe("resolved");
  });

  it("ignores a patch the owner's own later change has superseded", () => {
    const mine = threadAt(ME, T2, { status: "open" });
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { patches: { [mine.id]: { at: T1, status: "resolved" } } }),
    ]);
    expect(merged[0].status).toBe("open");
  });

  it("resolves competing patches by timestamp, then deterministically by author", () => {
    const mine = threadAt(ME, T0);
    const bob = { id: "bobId", name: "Bob" };
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { patches: { [mine.id]: { at: T2, status: "resolved" } } }),
      shardOf(bob, { patches: { [mine.id]: { at: T1, status: "open" } } }),
    ]);
    expect(merged[0].status).toBe("resolved");

    // Same instant on both machines: the tie must break the same way everywhere.
    const tied = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { patches: { [mine.id]: { at: T2, status: "resolved" } } }),
      shardOf(bob, { patches: { [mine.id]: { at: T2, status: "open" } } }),
    ]);
    expect(tied[0].status).toBe("open"); // "bobId" > "aliceId"
  });

  it("moves an anchor a collaborator re-pointed after editing the file", () => {
    const mine = threadAt(ME, T0);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, {
        patches: {
          [mine.id]: {
            at: T1,
            anchor: { fileRelPath: "chapters/intro.tex", fromOffset: 40, toOffset: 50, anchorText: "moved" },
          },
        },
      }),
    ]);
    expect(merged[0].fileRelPath).toBe("chapters/intro.tex");
    expect(merged[0].fromOffset).toBe(40);
    expect(merged[0].anchorText).toBe("moved");
  });

  it("a tombstone removes a thread that still exists in its owner's shard", () => {
    const mine = threadAt(ME, T0);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { patches: { [mine.id]: { at: T1, deleted: true } } }),
    ]);
    expect(merged).toHaveLength(0);
  });

  it("an owner's change after a tombstone keeps the thread alive", () => {
    const mine = threadAt(ME, T2);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { patches: { [mine.id]: { at: T1, deleted: true } } }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it("attributes a pre-identity comment to the shard it was found in", () => {
    // The legacy sidecar carried no author ids; everything in it was written by
    // whoever owns the file it was migrated into.
    const raw = JSON.stringify({
      schema: 1,
      authorId: ALICE.id,
      authorName: "Alice",
      threads: [
        {
          id: "t1",
          fileRelPath: "main.tex",
          fromOffset: 0,
          toOffset: 5,
          anchorText: "a",
          status: "open",
          createdAt: T0,
          comments: [{ id: "c1", author: "You", body: "Old note", createdAt: T0 }],
        },
      ],
    });
    const shard = parseShard(raw, ALICE.id);
    expect(shard).not.toBeNull();
    const merged = mergeShards([shard!]);
    expect(merged[0].authorId).toBe(ALICE.id);
    expect(merged[0].comments[0].authorId).toBe(ALICE.id);
  });
});

describe("parseShard", () => {
  it("rejects a file that is not a shard object", () => {
    expect(parseShard("[]", ME.id)).toBeNull();
    expect(parseShard("not json", ME.id)).toBeNull();
    expect(parseShard("null", ME.id)).toBeNull();
  });

  it("takes ownership from the file name, not from what the file claims", () => {
    // Otherwise one install could write comments attributed to another.
    const raw = JSON.stringify({ schema: 1, authorId: "someoneElse", authorName: "Mallory", threads: [] });
    expect(parseShard(raw, ALICE.id)?.authorId).toBe(ALICE.id);
  });

  it("drops threads with an unusable path or offsets instead of rendering them", () => {
    const bad = (over: Record<string, unknown>) => ({
      id: "t",
      fileRelPath: "main.tex",
      fromOffset: 0,
      toOffset: 5,
      anchorText: "a",
      status: "open",
      createdAt: T0,
      comments: [{ id: "c", author: "A", body: "b", createdAt: T0 }],
      ...over,
    });
    const raw = JSON.stringify({
      schema: 1,
      authorName: "Alice",
      threads: [
        bad({ fileRelPath: "../../../etc/passwd" }),
        bad({ fileRelPath: "/etc/passwd" }),
        bad({ fileRelPath: "C:\\Windows\\win.ini" }),
        bad({ fromOffset: -1 }),
        bad({ toOffset: 1, fromOffset: 5 }),
        bad({ createdAt: "not a date" }),
        bad({ comments: [] }),
      ],
    });
    expect(parseShard(raw, ALICE.id)?.threads).toHaveLength(0);
  });
});

describe("buildShard", () => {
  it("keeps our threads and our replies, and nobody else's data", () => {
    const mine = threadAt(ME, T0);
    const hers = threadAt(ALICE, T1);
    const merged = mergeShards([
      shardOf(ME, { threads: [mine] }),
      shardOf(ALICE, { threads: [hers] }),
    ]);
    // Both of us commented on both threads.
    merged[0].comments.push(reply("r-alice", ALICE, T2));
    merged[1].comments.push(reply("r-me", ME, T2));

    const built = buildShard(ME, merged, {});
    expect(built.threads.map((t) => t.id)).toEqual([mine.id]);
    // Alice's reply on our thread stays in Alice's shard, not duplicated here.
    expect(built.threads[0].comments.every((c) => c.authorId === ME.id)).toBe(true);
    expect(built.replies[hers.id]).toHaveLength(1);
    expect(built.replies[mine.id]).toBeUndefined();
  });

  it("round-trips through parseShard unchanged", () => {
    const mine = threadAt(ME, T0);
    const built = buildShard(ME, [mine], { other: { at: T1, deleted: true } });
    const reparsed = parseShard(JSON.stringify(built), ME.id);
    expect(reparsed?.threads.map((t) => t.id)).toEqual([mine.id]);
    expect(reparsed?.patches.other?.deleted).toBe(true);
  });
});

/**
 * Review comments are stored one file per install:
 * `<project>/.typeward/reviews/<authorId>.json`.
 *
 * The single-file sidecar this replaces was fine while comments were
 * machine-local, but a project shared through a folder-sync client (OneDrive,
 * Dropbox, Syncthing) has two apps writing it, neither of which sees the
 * other's version before saving its own whole-array rewrite. Whoever saved last
 * silently erased the rest. Sharding removes the shared write target entirely:
 * an install only ever writes its own file, so the sync client never has a
 * conflict to resolve, and the merged view is rebuilt from whatever files are
 * present.
 *
 * That makes each shard "everything this author contributed":
 *
 * - `threads`   threads they created, carrying only their own comments
 * - `replies`   their comments on someone else's thread, keyed by thread id
 * - `patches`   their edits to someone else's thread (resolve, re-anchor,
 *               delete), keyed by thread id
 *
 * Only the last of those needs a conflict rule. Threads and replies are append
 * only and keyed by unique ids, so they simply union. Status and anchor are
 * single-valued, so they resolve last-write-wins against
 * {@link threadClock} — the anchor genuinely has to be cross-author, since it
 * tracks shared document text that anyone editing the file moves.
 *
 * Shards arrive off the filesystem, written by another machine, so everything
 * read here is treated as untrusted input: shapes are validated field by field
 * and anything malformed is dropped rather than rendered.
 */

import type { Comment, CommentAuthor, CommentThread } from "./types";
import { threadClock } from "./types";

export const SHARD_SCHEMA = 1;

/** One author's edit to a thread they do not own. */
export interface ThreadPatch {
  /** ISO timestamp; the value compared against {@link threadClock}. */
  at: string;
  status?: "open" | "resolved";
  deleted?: true;
  anchor?: {
    fileRelPath: string;
    fromOffset: number;
    toOffset: number;
    anchorText: string;
  };
}

export interface ReviewShard {
  schema: number;
  authorId: string;
  authorName: string;
  threads: CommentThread[];
  replies: Record<string, Comment[]>;
  patches: Record<string, ThreadPatch>;
}

// Bounds on a file another machine wrote. Generous enough that no real project
// hits them, tight enough that a corrupt or hostile shard can't wedge the UI.
const MAX_THREADS_PER_SHARD = 5_000;
const MAX_COMMENTS_PER_THREAD = 500;
const MAX_BODY_CHARS = 8_000;
const MAX_NAME_CHARS = 120;
const MAX_ANCHOR_CHARS = 80;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function offset(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/**
 * A thread's path must stay inside the project. Rust re-validates every path it
 * is handed, so this is about not surfacing a nonsense row in the panel (and
 * not aiming a read at one) rather than about being the security boundary.
 */
function relPath(v: unknown): string | null {
  const p = str(v, 1_024);
  if (p === null || p === "") return null;
  const normalized = p.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split("/").some((seg) => seg === "..")) return null;
  return p;
}

function parseComment(raw: unknown, fallbackAuthor: CommentAuthor): Comment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const body = str(r.body, MAX_BODY_CHARS);
  const createdAt = isoDate(r.createdAt);
  if (id === null || body === null || createdAt === null) return null;
  // A comment written before comments carried identity belongs to whoever owns
  // the shard it was found in — that file was machine-local by construction.
  const authorId = str(r.authorId, 64) ?? fallbackAuthor.id;
  const author = str(r.author, MAX_NAME_CHARS) ?? "";
  return {
    id,
    author: author === "" && authorId === fallbackAuthor.id ? fallbackAuthor.name : author,
    authorId,
    body,
    createdAt,
  };
}

function parseThread(raw: unknown, owner: CommentAuthor): CommentThread | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const fileRelPath = relPath(r.fileRelPath);
  const fromOffset = offset(r.fromOffset);
  const toOffset = offset(r.toOffset);
  const createdAt = isoDate(r.createdAt);
  if (id === null || fileRelPath === null || createdAt === null) return null;
  if (fromOffset === null || toOffset === null || toOffset < fromOffset) return null;

  const comments = (Array.isArray(r.comments) ? r.comments : [])
    .slice(0, MAX_COMMENTS_PER_THREAD)
    .map((c) => parseComment(c, owner))
    .filter((c): c is Comment => c !== null);
  // A thread with no readable root comment has nothing to render.
  if (comments.length === 0) return null;

  return {
    id,
    fileRelPath,
    fromOffset,
    toOffset,
    anchorText: str(r.anchorText, MAX_ANCHOR_CHARS) ?? "",
    status: r.status === "resolved" ? "resolved" : "open",
    comments,
    createdAt,
    kind: r.kind === "todo" ? "todo" : "comment",
    authorId: str(r.authorId, 64) ?? owner.id,
    updatedAt: isoDate(r.updatedAt) ?? createdAt,
  };
}

function parsePatch(raw: unknown): ThreadPatch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const at = isoDate(r.at);
  if (at === null) return null;
  const patch: ThreadPatch = { at };
  if (r.status === "open" || r.status === "resolved") patch.status = r.status;
  if (r.deleted === true) patch.deleted = true;
  if (typeof r.anchor === "object" && r.anchor !== null) {
    const a = r.anchor as Record<string, unknown>;
    const fileRelPath = relPath(a.fileRelPath);
    const fromOffset = offset(a.fromOffset);
    const toOffset = offset(a.toOffset);
    if (fileRelPath !== null && fromOffset !== null && toOffset !== null && toOffset >= fromOffset) {
      patch.anchor = {
        fileRelPath,
        fromOffset,
        toOffset,
        anchorText: str(a.anchorText, MAX_ANCHOR_CHARS) ?? "",
      };
    }
  }
  // A patch that survived validation but carries no field is inert; dropping it
  // keeps the merge from having to reason about empty ones.
  return patch.status || patch.deleted || patch.anchor ? patch : null;
}

/**
 * Parse one shard file. `fallbackId` names the file it came from, which is the
 * authority on ownership: a shard claiming an `authorId` other than its own
 * file name would let one install write comments attributed to another.
 */
export function parseShard(raw: string, fallbackId: string): ReviewShard | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;

  const owner: CommentAuthor = {
    id: fallbackId,
    name: str(r.authorName, MAX_NAME_CHARS) ?? "",
  };

  const threads = (Array.isArray(r.threads) ? r.threads : [])
    .slice(0, MAX_THREADS_PER_SHARD)
    .map((t) => parseThread(t, owner))
    .filter((t): t is CommentThread => t !== null);

  const replies: Record<string, Comment[]> = {};
  if (typeof r.replies === "object" && r.replies !== null) {
    for (const [threadId, list] of Object.entries(r.replies as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const parsedList = list
        .slice(0, MAX_COMMENTS_PER_THREAD)
        .map((c) => parseComment(c, owner))
        .filter((c): c is Comment => c !== null);
      if (parsedList.length > 0) replies[threadId] = parsedList;
    }
  }

  const patches: Record<string, ThreadPatch> = {};
  if (typeof r.patches === "object" && r.patches !== null) {
    for (const [threadId, p] of Object.entries(r.patches as Record<string, unknown>)) {
      const patch = parsePatch(p);
      if (patch !== null) patches[threadId] = patch;
    }
  }

  return {
    schema: typeof r.schema === "number" ? r.schema : SHARD_SCHEMA,
    authorId: owner.id,
    authorName: owner.name,
    threads,
    replies,
    patches,
  };
}

/** Compare two ISO timestamps, breaking exact ties on author id for determinism. */
function newer(at: string, byAuthor: string, thanAt: string, thanAuthor: string): boolean {
  if (at !== thanAt) return at > thanAt;
  return byAuthor > thanAuthor;
}

/**
 * Fold every shard into the single thread list the panels render.
 *
 * Deterministic: the result depends only on the set of shards, not on the order
 * they were read, so two machines looking at the same folder see the same
 * threads in the same order.
 */
export function mergeShards(shards: ReviewShard[]): CommentThread[] {
  const ordered = [...shards].sort((a, b) => (a.authorId < b.authorId ? -1 : 1));

  const base = new Map<string, CommentThread>();
  for (const shard of ordered) {
    for (const thread of shard.threads) {
      const existing = base.get(thread.id);
      if (existing === undefined) {
        base.set(thread.id, { ...thread, comments: [...thread.comments] });
        continue;
      }
      // The same thread id in two shards means a shard file was copied, not
      // that two people wrote the same thread. The copy sitting in its rightful
      // owner's file wins; otherwise the first shard in id order does, so every
      // machine picks the same one.
      if (thread.authorId === shard.authorId && existing.authorId !== shard.authorId) {
        base.set(thread.id, { ...thread, comments: [...thread.comments] });
      }
    }
  }

  for (const shard of ordered) {
    for (const [threadId, comments] of Object.entries(shard.replies)) {
      const thread = base.get(threadId);
      if (thread === undefined) continue;
      const seen = new Set(thread.comments.map((c) => c.id));
      for (const comment of comments) {
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        thread.comments.push(comment);
      }
    }
  }

  for (const [threadId, thread] of base) {
    const clock = threadClock(thread);
    let status: { at: string; by: string; value: "open" | "resolved" } | null = null;
    let anchor: { at: string; by: string; value: NonNullable<ThreadPatch["anchor"]> } | null = null;
    let deleted = false;

    for (const shard of ordered) {
      const patch = shard.patches[threadId];
      if (patch === undefined) continue;
      // A patch from before the owner's own last change has already been
      // superseded. An exact tie goes to the patch: it was necessarily recorded
      // after the state it was applied to was read, and sub-millisecond
      // ordering is not recoverable from an ISO timestamp anyway.
      if (patch.at < clock) continue;
      if (patch.deleted) deleted = true;
      if (patch.status && (status === null || newer(patch.at, shard.authorId, status.at, status.by))) {
        status = { at: patch.at, by: shard.authorId, value: patch.status };
      }
      if (patch.anchor && (anchor === null || newer(patch.at, shard.authorId, anchor.at, anchor.by))) {
        anchor = { at: patch.at, by: shard.authorId, value: patch.anchor };
      }
    }

    if (deleted) {
      base.delete(threadId);
      continue;
    }
    if (status !== null) thread.status = status.value;
    if (anchor !== null) {
      thread.fileRelPath = anchor.value.fileRelPath;
      thread.fromOffset = anchor.value.fromOffset;
      thread.toOffset = anchor.value.toOffset;
      thread.anchorText = anchor.value.anchorText;
    }
    // One clock for the thread, advanced to the newest change that landed on
    // it, so the next merge compares against what this one actually applied.
    for (const at of [status?.at, anchor?.at]) {
      if (at !== undefined && at > threadClock(thread)) thread.updatedAt = at;
    }
  }

  for (const thread of base.values()) {
    // The root comment stays at index 0 whatever its timestamp says. Clocks on
    // two machines are not in sync, so a reply written moments later can carry
    // an earlier timestamp, and sorting it to the front would silently rewrite
    // whose comment the thread is.
    const [root, ...rest] = thread.comments;
    rest.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    thread.comments = [root, ...rest];
  }

  return [...base.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/**
 * Project the merged thread list back down to this install's own shard.
 *
 * Foreign replies are deliberately not carried: they live in their author's
 * shard, and re-persisting them here would make this file the second home for
 * data it does not own.
 */
export function buildShard(
  author: CommentAuthor,
  threads: CommentThread[],
  patches: Record<string, ThreadPatch>,
): ReviewShard {
  const own: CommentThread[] = [];
  const replies: Record<string, Comment[]> = {};

  for (const thread of threads) {
    if (thread.authorId === author.id) {
      own.push({
        ...thread,
        comments: thread.comments.filter((c) => c.authorId === author.id),
      });
      continue;
    }
    const mine = thread.comments.filter((c) => c.authorId === author.id);
    if (mine.length > 0) replies[thread.id] = mine;
  }

  // Patches for threads that no longer exist anywhere are still kept: a
  // tombstone has to outlive the thread it deletes, or the next merge with the
  // owner's shard resurrects it.
  return {
    schema: SHARD_SCHEMA,
    authorId: author.id,
    authorName: author.name,
    threads: own,
    replies,
    patches,
  };
}

/** The patch that records what this install did to a thread it does not own. */
export function patchForThread(thread: CommentThread): ThreadPatch {
  return {
    at: threadClock(thread),
    status: thread.status,
    anchor: {
      fileRelPath: thread.fileRelPath,
      fromOffset: thread.fromOffset,
      toOffset: thread.toOffset,
      anchorText: thread.anchorText,
    },
  };
}

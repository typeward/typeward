import { nanoid } from "nanoid";

/**
 * Who wrote a comment. `id` is the author's per-install id (settings
 * `profile.localId`); `name` is their display name, denormalized into every
 * comment on purpose. A collaborator's shard is the only record of who they
 * are, so a name resolved at read time would render as blank the moment the
 * shard is merged on a machine that has never met them.
 */
export interface CommentAuthor {
  id: string;
  name: string;
}

export interface CommentThread {
  id: string;
  fileRelPath: string;
  fromOffset: number;
  toOffset: number;
  anchorText: string;
  status: "open" | "resolved";
  comments: Comment[];
  createdAt: string;
  /**
   * Review comment vs a TODO (e.g. created from a PDF selection). Absent is
   * treated as "comment" everywhere, so this is additive for old sidecars.
   */
  kind?: "comment" | "todo";
  /**
   * The install that created the thread, and therefore the shard that owns it.
   * Absent in threads written before comments carried identity; the shard merge
   * fills it in from the file the thread was read out of.
   */
  authorId?: string;
  /**
   * Clock for the mutable fields (status and anchor), bumped on every change.
   * Two people editing one project through a folder-sync client resolve those
   * fields last-write-wins, and this is the value they compare. Absent means
   * "never changed since `createdAt`".
   */
  updatedAt?: string;
}

export interface Comment {
  id: string;
  /** Display name as of the moment it was written. */
  author: string;
  /**
   * The install that wrote it. Absent in pre-identity comments, which the shard
   * merge attributes to the owner of the shard they were found in.
   */
  authorId?: string;
  body: string;
  createdAt: string;
}

export function createThread(
  fileRelPath: string,
  fromOffset: number,
  toOffset: number,
  anchorText: string,
  author: CommentAuthor,
  body: string,
  kind: "comment" | "todo" = "comment",
): CommentThread {
  const now = new Date().toISOString();
  return {
    id: nanoid(),
    fileRelPath,
    fromOffset,
    toOffset,
    anchorText: anchorText.slice(0, 80),
    status: "open",
    comments: [
      { id: nanoid(), author: author.name, authorId: author.id, body, createdAt: now },
    ],
    createdAt: now,
    kind,
    authorId: author.id,
    updatedAt: now,
  };
}

export function addReply(
  thread: CommentThread,
  author: CommentAuthor,
  body: string,
): CommentThread {
  return {
    ...thread,
    comments: [
      ...thread.comments,
      {
        id: nanoid(),
        author: author.name,
        authorId: author.id,
        body,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

export function resolveThread(thread: CommentThread): CommentThread {
  return { ...thread, status: "resolved", updatedAt: new Date().toISOString() };
}

export function reopenThread(thread: CommentThread): CommentThread {
  return { ...thread, status: "open", updatedAt: new Date().toISOString() };
}

/** The clock a merge compares when resolving status and anchor across shards. */
export function threadClock(thread: CommentThread): string {
  return thread.updatedAt ?? thread.createdAt;
}

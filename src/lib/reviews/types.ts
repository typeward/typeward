import { nanoid } from "nanoid";

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
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export function createThread(
  fileRelPath: string,
  fromOffset: number,
  toOffset: number,
  anchorText: string,
  author: string,
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
    comments: [{ id: nanoid(), author, body, createdAt: now }],
    createdAt: now,
    kind,
  };
}

export function addReply(
  thread: CommentThread,
  author: string,
  body: string,
): CommentThread {
  return {
    ...thread,
    comments: [
      ...thread.comments,
      { id: nanoid(), author, body, createdAt: new Date().toISOString() },
    ],
  };
}

export function resolveThread(thread: CommentThread): CommentThread {
  return { ...thread, status: "resolved" };
}

export function reopenThread(thread: CommentThread): CommentThread {
  return { ...thread, status: "open" };
}

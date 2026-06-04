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

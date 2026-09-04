import type { CommentThread } from "./types";
import { toLF } from "./lines";

export interface RecoveredThread {
  thread: CommentThread;
  fromOffset: number;
  toOffset: number;
  recoveryStatus: "exact" | "fuzzy" | "orphaned";
}

export function recoverThreads(
  threads: CommentThread[],
  fileContent: string,
  fileRelPath: string,
): RecoveredThread[] {
  // Thread offsets are LF-space; callers may hand disk-flavored CRLF content.
  const content = toLF(fileContent);
  return threads
    .filter((t) => t.fileRelPath === fileRelPath)
    .map((thread) => recover(thread, content));
}

function recover(thread: CommentThread, content: string): RecoveredThread {
  const { fromOffset, toOffset } = thread;
  // Anchors captured before offsets were LF-normalized may carry CRLF.
  const anchorText = toLF(thread.anchorText);

  if (
    fromOffset >= 0 &&
    toOffset <= content.length &&
    content.slice(fromOffset, toOffset) === anchorText
  ) {
    return { thread, fromOffset, toOffset, recoveryStatus: "exact" };
  }

  const fullMatch = findUnique(content, anchorText);
  if (fullMatch !== null) {
    return {
      thread,
      fromOffset: fullMatch,
      toOffset: fullMatch + anchorText.length,
      recoveryStatus: "fuzzy",
    };
  }

  if (anchorText.length > 40) {
    const short = anchorText.slice(0, 40);
    const shortMatch = findUnique(content, short);
    if (shortMatch !== null) {
      return {
        thread,
        fromOffset: shortMatch,
        toOffset: shortMatch + short.length,
        recoveryStatus: "fuzzy",
      };
    }
  }

  return { thread, fromOffset, toOffset, recoveryStatus: "orphaned" };
}

function findUnique(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle);
  if (first === -1) return null;
  const second = haystack.indexOf(needle, first + 1);
  if (second !== -1) return null;
  return first;
}

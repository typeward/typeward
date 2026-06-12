import { createSignal } from "solid-js";
import type { CommentThread } from "~/lib/reviews/types";
import { addReply, resolveThread, reopenThread } from "~/lib/reviews/types";
import { activeFile, project } from "~/stores/editor-store";
import * as ipc from "~/ipc";

const SIDECAR_REL_PATH = ".typeward/reviews/comments.json";
const SAVE_DEBOUNCE_MS = 1_500;

const [allThreads, setAllThreads] = createSignal<CommentThread[]>([]);
const [showResolved, setShowResolved] = createSignal(false);

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
// Root captured when the save was scheduled — the debounce can outlive a
// project switch, and writing to whatever project() points at by then would
// drop one project's threads into another's sidecar.
let _pendingRoot: string | null = null;

function threadsForFile(relPath: string): CommentThread[] {
  return allThreads().filter((t) => t.fileRelPath === relPath);
}

function activeFileThreads(): CommentThread[] {
  const f = activeFile();
  return f ? threadsForFile(f.relPath) : [];
}

function visibleActiveFileThreads(): CommentThread[] {
  const base = activeFileThreads();
  return showResolved() ? base : base.filter((t) => t.status === "open");
}

function activeFileOpenThreadCount(): number {
  return activeFileThreads().filter((t) => t.status === "open").length;
}

function allOpenThreadCount(): number {
  return allThreads().filter((t) => t.status === "open").length;
}

function addThread(thread: CommentThread): void {
  setAllThreads((prev) => [...prev, thread]);
  scheduleSave();
}

function addReplyToThread(threadId: string, author: string, body: string): void {
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? addReply(t, author, body) : t)),
  );
  scheduleSave();
}

function resolveThreadById(threadId: string): void {
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? resolveThread(t) : t)),
  );
  scheduleSave();
}

function reopenThreadById(threadId: string): void {
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? reopenThread(t) : t)),
  );
  scheduleSave();
}

function removeThread(threadId: string): void {
  setAllThreads((prev) => prev.filter((t) => t.id !== threadId));
  scheduleSave();
}

function updateThreadOffsets(
  fileRelPath: string,
  updates: Array<{ id: string; fromOffset: number; toOffset: number; anchorText: string }>,
): void {
  const map = new Map(updates.map((u) => [u.id, u]));
  setAllThreads((prev) =>
    prev.map((t) => {
      if (t.fileRelPath !== fileRelPath) return t;
      const u = map.get(t.id);
      if (!u) return t;
      return { ...t, fromOffset: u.fromOffset, toOffset: u.toOffset, anchorText: u.anchorText };
    }),
  );
  scheduleSave();
}

async function loadThreads(isCurrent: () => boolean = () => true): Promise<void> {
  const proj = project();
  if (!proj) return;
  try {
    const raw = await ipc.readProjectTextFile(proj.rootPath, SIDECAR_REL_PATH);
    if (!isCurrent()) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      setAllThreads(parsed);
    }
  } catch {
    if (!isCurrent()) return;
    setAllThreads([]);
  }
}

function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _pendingRoot = project()?.rootPath ?? null;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const root = _pendingRoot;
    _pendingRoot = null;
    // A project switch flushes pending saves explicitly; if the timer still
    // fires across one (missed flush), refuse rather than cross-write.
    if (root && root === project()?.rootPath) void writeThreads(root);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Write any pending debounced save immediately, to the project that was
 * active when it was scheduled. Call before resetting on a project switch.
 */
async function flushPendingReviewSave(): Promise<void> {
  if (!_saveTimer) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  const root = _pendingRoot;
  _pendingRoot = null;
  if (root) await writeThreads(root);
}

/** Clear in-memory threads on project switch/close (cancels pending saves). */
function resetThreads(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  _pendingRoot = null;
  setAllThreads([]);
}

async function saveThreads(): Promise<void> {
  const proj = project();
  if (!proj) return;
  await writeThreads(proj.rootPath);
}

async function writeThreads(rootPath: string): Promise<void> {
  const data = JSON.stringify(allThreads(), null, 2);
  try {
    await ipc.writeProjectTextFile(rootPath, SIDECAR_REL_PATH, data);
  } catch {
    // save is non-critical; failures are intentionally swallowed
  }
}

function _resetForTests(): void {
  resetThreads();
  setShowResolved(false);
}

export {
  allThreads,
  setAllThreads,
  showResolved,
  setShowResolved,
  threadsForFile,
  activeFileThreads,
  visibleActiveFileThreads,
  activeFileOpenThreadCount,
  allOpenThreadCount,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  updateThreadOffsets,
  loadThreads,
  saveThreads,
  flushPendingReviewSave,
  resetThreads,
  _resetForTests,
};

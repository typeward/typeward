import { describeIpcError } from "~/lib/errors";
import { notifyError } from "~/lib/toast";
import { createSignal } from "solid-js";
import type { CommentThread } from "~/lib/reviews/types";
import { addReply, resolveThread, reopenThread } from "~/lib/reviews/types";
import { project } from "~/stores/editor-store";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";

// Review comments persist to a machine-local sidecar under the project's
// `.typeward/` dir. Format: a JSON array of CommentThread. This is primary
// user-authored data (not a derived cache), but it lives in the non-portable
// `.typeward/` tree — it does NOT travel with a cloud-synced or git-tracked
// copy of the project (both exclude `.typeward/`). See finding #35: a durable
// relocation is deferred; documented here so the trade-off is explicit.
const SIDECAR_REL_PATH = ".typeward/reviews/comments.json";
const SAVE_DEBOUNCE_MS = 1_500;

const [allThreads, setAllThreads] = createSignal<CommentThread[]>([]);
const [showResolved, setShowResolved] = createSignal(false);

// "Open the review panel (optionally targeting a thread)" intent — mirrors the
// requestNewProject/requestSaveTemplate pattern in palette-store. The shell
// observes this, switches to the Review tab, hands the threadId to
// `focusedThreadId`, and clears the intent. The `generation` makes repeated
// clicks on the SAME thread re-fire (new object identity each call).
export interface ReviewPanelIntent {
  threadId?: string;
  // Which sidebar tab to open — comment threads land in "review", TODO-kind
  // threads (e.g. from a PDF selection) in "todo".
  panel: "review" | "todo";
  generation: number;
}
const [reviewPanelIntent, setReviewPanelIntent] =
  createSignal<ReviewPanelIntent | null>(null);
let _reviewIntentGen = 0;

/** Ask the shell to open the review/TODO panel, optionally scrolled to a thread. */
export function requestReviewPanelIntent(
  threadId?: string,
  panel: "review" | "todo" = "review",
): void {
  setReviewPanelIntent({ threadId, panel, generation: ++_reviewIntentGen });
}

/**
 * Compose intent for a new editor-anchored comment/TODO. The add-comment
 * commands raise this instead of creating a thread outright — an empty
 * thread appearing silently in the panel reads as "nothing happened", and
 * the PDF selection path already composes first. The ReviewComposePopover
 * mounted in the editor shell observes and clears it.
 */
export interface ReviewComposeIntent {
  kind: "comment" | "todo";
  /** Selection span + snapshot at the moment the command fired. */
  from: number;
  to: number;
  anchorText: string;
}
const [composeIntent, setComposeIntent] =
  createSignal<ReviewComposeIntent | null>(null);
export const reviewComposeIntent = composeIntent;
export const requestReviewCompose = (intent: ReviewComposeIntent): void => {
  setComposeIntent(intent);
};
export const clearReviewCompose = (): void => {
  setComposeIntent(null);
};

/**
 * Open a thread in the correct panel, routing TODO-kind threads to the TODO
 * tab. Shared by gutter clicks and PDF band clicks, which only know a threadId.
 */
export function requestThreadPanel(threadId: string): void {
  const thread = allThreads().find((t) => t.id === threadId);
  const panel = (thread?.kind ?? "comment") === "todo" ? "todo" : "review";
  requestReviewPanelIntent(threadId, panel);
}

// The thread the ReviewPanel should scroll to + expand. Set by the shell from
// the intent; consumed and cleared by the panel.
const [focusedThreadId, setFocusedThreadId] = createSignal<string | null>(null);
export function clearFocusedThread(): void {
  setFocusedThreadId(null);
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
// Root captured when the save was scheduled — the debounce can outlive a
// project switch, and writing to whatever project() points at by then would
// drop one project's threads into another's sidecar.
let _pendingRoot: string | null = null;
// Refuse to persist until a clean load has established what's on disk. A read
// or parse failure that got laundered into an empty writable state would let
// the next save overwrite (and destroy) real threads that merely failed to
// load. Set true on reset, flipped false only by a successful/not-found load.
let _readOnly = true;
// One save-failure toast per project — a repeatedly failing debounce must not
// spam the user, but the failure must not be silent either.
let _writeErrorToastedRoot: string | null = null;
// Bumped whenever the store starts a new lifecycle (reset, or a load that
// established a project's threads) — lets a slow flush from a closed editor
// detect that its trailing reset has gone stale.
let _lifecycleGen = 0;

function threadsForFile(relPath: string): CommentThread[] {
  return allThreads().filter((t) => t.fileRelPath === relPath);
}

function openCommentThreadCount(): number {
  return allThreads().filter(
    (t) => t.status === "open" && (t.kind ?? "comment") !== "todo",
  ).length;
}

function openTodoThreads(): CommentThread[] {
  return allThreads().filter(
    (t) => t.status === "open" && (t.kind ?? "comment") === "todo",
  );
}

function openTodoThreadCount(): number {
  return openTodoThreads().length;
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

/**
 * Re-point an orphaned thread at a fresh range (the current editor selection).
 * The store is the single source of truth for anchors, so updating it here is
 * enough — the CM bridge re-derives decorations from the store.
 */
function reanchorThreadById(
  threadId: string,
  fromOffset: number,
  toOffset: number,
  anchorText: string,
): void {
  setAllThreads((prev) =>
    prev.map((t) =>
      t.id === threadId
        ? { ...t, fromOffset, toOffset, anchorText: anchorText.slice(0, 80) }
        : t,
    ),
  );
  scheduleSave();
}

/**
 * Repoint every thread anchored to `oldRel` at `newRel` after a file rename, so
 * comments/TODOs stay attached to the renamed file. Offsets are unchanged — the
 * rename moved the exact bytes.
 */
function remapThreadFile(oldRel: string, newRel: string): void {
  let changed = false;
  setAllThreads((prev) =>
    prev.map((t) => {
      if (t.fileRelPath !== oldRel) return t;
      changed = true;
      return { ...t, fileRelPath: newRel };
    }),
  );
  if (changed) scheduleSave();
}

/**
 * Directory-prefix sibling of {@link remapThreadFile}: repoint every thread
 * under a moved/renamed directory. Offsets are unchanged — the move relocated
 * the exact bytes.
 */
function remapThreadDir(oldDirRel: string, newDirRel: string): void {
  const prefix = `${oldDirRel}/`;
  let changed = false;
  setAllThreads((prev) =>
    prev.map((t) => {
      if (!t.fileRelPath.startsWith(prefix)) return t;
      changed = true;
      return { ...t, fileRelPath: newDirRel + t.fileRelPath.slice(oldDirRel.length) };
    }),
  );
  if (changed) scheduleSave();
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

/**
 * A missing sidecar (fresh project, no reviews yet) is normal and writable; a
 * genuine read failure (permission, lock) must NOT be — hence the distinction.
 * We can't call the fs plugin here (its scope is Documents-only, but project
 * reads go through a custom root-registered IPC that also serves out-of-scope
 * roots), so we classify by the io error the Rust read surfaces. NotFound is
 * "os error 2" on every platform; anything else is treated as a real failure.
 */
function isNotFoundError(e: unknown): boolean {
  const msg = (
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : describeIpcError(e)
  ).toLowerCase();
  return (
    msg.includes("os error 2") ||
    msg.includes("no such file") ||
    msg.includes("cannot find the file") ||
    msg.includes("cannot find the path")
  );
}

async function loadThreads(isCurrent: () => boolean = () => true): Promise<void> {
  const proj = project();
  if (!proj) return;
  let raw: string;
  try {
    raw = await ipc.readProjectTextFile(proj.rootPath, SIDECAR_REL_PATH);
  } catch (e) {
    if (!isCurrent()) return;
    if (isNotFoundError(e)) {
      // No sidecar yet — an empty, writable slate.
      _lifecycleGen++;
      setAllThreads([]);
      _readOnly = false;
    } else {
      // A real read failure. Stay read-only so the next save can't overwrite
      // threads that are present on disk but that we failed to load.
      recordError("reviews-load", `reading ${SIDECAR_REL_PATH} failed`, e);
    }
    return;
  }
  if (!isCurrent()) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _lifecycleGen++;
      setAllThreads(parsed);
      _readOnly = false;
    } else {
      // Valid JSON, wrong shape — treat as corrupt; don't clobber it.
      recordError(
        "reviews-load",
        `${SIDECAR_REL_PATH} is not a thread array`,
      );
    }
  } catch (e) {
    // Corrupt sidecar — stay read-only rather than overwrite it on next save.
    recordError("reviews-load", `parsing ${SIDECAR_REL_PATH} failed`, e);
  }
}

function scheduleSave(): void {
  if (_readOnly) return;
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

/**
 * Flush any pending save, then clear the store — unless another project's
 * threads loaded meanwhile. A slow flush from a closed editor must not wipe
 * (and read-only-lock) the reopened project's freshly loaded threads; the
 * write itself is safe to keep because the flush snapshots its payload and
 * target root synchronously, before the first await.
 */
async function flushAndResetThreads(): Promise<void> {
  const gen = _lifecycleGen;
  await flushPendingReviewSave();
  if (gen === _lifecycleGen) resetThreads();
}

/** Clear in-memory threads on project switch/close (cancels pending saves). */
function resetThreads(): void {
  _lifecycleGen++;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  _pendingRoot = null;
  _writeErrorToastedRoot = null;
  // Block saves until loadThreads establishes what's on disk for the next
  // project — otherwise a mutation in the load gap could overwrite it.
  _readOnly = true;
  setAllThreads([]);
}

async function writeThreads(rootPath: string): Promise<void> {
  if (_readOnly) return;
  const data = JSON.stringify(allThreads(), null, 2);
  try {
    await ipc.writeProjectTextFile(rootPath, SIDECAR_REL_PATH, data);
    if (_writeErrorToastedRoot === rootPath) _writeErrorToastedRoot = null;
  } catch (e) {
    // Review comments are primary user data with no other persistence — a
    // silent drop is data loss. Surface it (once per project) and keep the
    // save "dirty" by re-arming the debounce so it retries.
    recordError("reviews-save", `writing ${SIDECAR_REL_PATH} failed`, e);
    if (_writeErrorToastedRoot !== rootPath) {
      _writeErrorToastedRoot = rootPath;
      notifyError("Couldn't save review comments", describeIpcError(e));
    }
    if (rootPath === project()?.rootPath) scheduleSave();
  }
}

function _resetForTests(): void {
  resetThreads();
  setShowResolved(false);
}

export {
  allThreads,
  showResolved,
  setShowResolved,
  reviewPanelIntent,
  setReviewPanelIntent,
  focusedThreadId,
  setFocusedThreadId,
  threadsForFile,
  openCommentThreadCount,
  openTodoThreads,
  openTodoThreadCount,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  reanchorThreadById,
  remapThreadDir,
  remapThreadFile,
  updateThreadOffsets,
  loadThreads,
  flushPendingReviewSave,
  flushAndResetThreads,
  resetThreads,
  _resetForTests,
};

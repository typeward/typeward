import { createMemo, createRoot, createSignal, untrack } from "solid-js";
import type { Setter } from "solid-js";
import type { CompileResult, Project } from "~/adapters/types";
import { perfMark } from "~/lib/perf-marks";

export interface OpenFile {
  /** Absolute path. */
  path: string;
  /** Path relative to project.rootPath. */
  relPath: string;
  content: string;
  dirty: boolean;
  /**
   * SHA-256 of the on-disk content this buffer was loaded from (and updated on
   * every successful save). The save path compares the live disk hash against
   * this to detect that the file changed underneath the buffer — e.g. a cloud
   * pull applied a collaborator's edit — so a save can preserve the other copy
   * instead of silently reverting it. Undefined for buffers whose disk origin
   * is unknown (conflict-inspection tabs), which skip the guard.
   */
  baseHash?: string;
  /**
   * Bumped whenever `adoptDiskContent` replaces this buffer's content outside
   * CodeMirror (history restore, sync conflict resolution). `text-shell` folds
   * it into the editor key, so the mounted editor for the active tab remounts
   * on the adopted content instead of keeping its stale doc — which one
   * keystroke plus autosave would otherwise write back over the new state.
   */
  adoptGeneration?: number;
}

/**
 * Forward-search target: the PdfViewer scrolls to (page, y) and pulses a
 * highlight. Each request bumps `generation` so two consecutive jumps to
 * the same location both trigger the effect (Solid would otherwise dedupe).
 */
export interface PdfScrollTarget {
  /** 1-based page index. */
  page: number;
  /** PDF points from the top of that page. */
  y: number;
  /** Strictly-increasing request id. */
  generation: number;
}

/**
 * Inverse-search intent: "please open <file> and put the cursor at <line>".
 * Acted on by EditorScreen + the editor-view-store. Same generation trick.
 */
export interface GotoSourceIntent {
  /** Path relative to project.rootPath. */
  relPath: string;
  line: number;
  /** When set, select these 0-based document offsets instead of the line. */
  range?: { from: number; to: number };
  generation: number;
}

const [project, setProject] = createSignal<Project | null>(null);
const [openFiles, setOpenFiles] = createSignal<OpenFile[]>([]);
const [activeIndex, setActiveIndexRaw] = createSignal<number>(-1);
// Every tab activation lands on this setter (tab strip, cycling, tree
// activation, close reindex), so it is the one place the tab-switch perf mark
// can cover them all — stamped BEFORE the write because the keyed editor
// remount runs synchronously inside it and the measure fires from onReady.
const setActiveIndex: Setter<number> = ((arg?: number | ((p: number) => number)) => {
  const prev = untrack(activeIndex);
  const next = typeof arg === "function" ? arg(prev) : (arg as number);
  if (next !== prev && next >= 0 && prev >= 0) perfMark("tab-switch");
  return setActiveIndexRaw(next);
}) as Setter<number>;
const [compileState, setCompileState] = createSignal<
  "idle" | "compiling" | "ok" | "error"
>("idle");
const [lastResult, setLastResult] = createSignal<CompileResult | null>(null);
// Compiler output streamed live while a build runs (Rust LogSink chunks over
// the compile:log event). Bounded: keep the newest window; the FULL log
// arrives with the CompileResult, this only feeds the in-flight view.
const LIVE_LOG_CAP = 2 * 1024 * 1024;
const [liveLog, setLiveLog] = createSignal("");
function appendLiveLog(chunk: string): void {
  setLiveLog((cur) => {
    const next = cur + chunk;
    return next.length > LIVE_LOG_CAP ? next.slice(next.length - LIVE_LOG_CAP) : next;
  });
}
function clearLiveLog(): void {
  setLiveLog("");
}
const [pdfVersion, bumpPdfVersion] = (() => {
  const [v, set] = createSignal(0);
  return [v, () => set((n) => n + 1)];
})();
const [pdfScrollTarget, setPdfScrollTargetInternal] =
  createSignal<PdfScrollTarget | null>(null);
const [gotoSourceIntent, setGotoSourceIntentInternal] =
  createSignal<GotoSourceIntent | null>(null);
let _scrollGen = 0;
let _gotoGen = 0;

export const requestPdfScroll = (page: number, y: number): void => {
  _scrollGen++;
  setPdfScrollTargetInternal({ page, y, generation: _scrollGen });
};

export const requestGotoSource = (
  relPath: string,
  line: number,
  range?: { from: number; to: number },
): void => {
  _gotoGen++;
  setGotoSourceIntentInternal({ relPath, line, range, generation: _gotoGen });
};

// Owned by a module-level root so this page-lifetime memo isn't created in a
// stray reactive scope (which logs "computations created outside a createRoot
// or render will never be disposed" at boot). The root is intentionally never
// disposed — this store lives for the app's lifetime.
const activeFile = createRoot(() =>
  createMemo<OpenFile | null>(() => {
    const i = activeIndex();
    const files = openFiles();
    return i >= 0 && i < files.length ? files[i] : null;
  }),
);

/** Replace the currently-active file's state (content, dirty, etc.). */
function updateActiveFile(patch: Partial<OpenFile>): void {
  const i = activeIndex();
  if (i < 0) return;
  setOpenFiles((prev) => {
    const next = prev.slice();
    next[i] = { ...next[i], ...patch };
    return next;
  });
}

/**
 * Open a file by relative path. If already open, just activate its tab.
 * Otherwise append a new tab and activate it.
 */
function openFile(file: OpenFile): void {
  if (activateFileIfOpen(file.path)) return;
  setOpenFiles((prev) => [...prev, file]);
  setActiveIndex(openFiles().length - 1);
}

/**
 * Activate an already-open tab by absolute path. Returns false when no tab
 * matches. Lets callers skip the disk read entirely for open files — the
 * dedupe branch of openFile discards freshly-read content anyway.
 */
function activateFileIfOpen(path: string): boolean {
  const existing = openFiles().findIndex((f) => f.path === path);
  if (existing < 0) return false;
  setActiveIndex(existing);
  return true;
}

/**
 * Activate an already-open tab by project-relative path. Quick-open uses this
 * so hopping between open files keeps cursor/scroll (a goto intent would yank
 * the caret to line 1); returns false when the file isn't open.
 */
export function activateFileByRelPath(relPath: string): boolean {
  const existing = openFiles().findIndex((f) => f.relPath === relPath);
  if (existing < 0) return false;
  setActiveIndex(existing);
  return true;
}

/**
 * Mark a file clean (saved) by path, but only if its buffer still holds the
 * exact content that was written. Guards the save race where the user keeps
 * typing during the async write, or switches tabs before it resolves — we
 * must not clear `dirty` on content the disk doesn't have, nor on a different
 * tab that happens to be active when the write completes.
 */
function markFileCleanIfUnchanged(path: string, content: string): void {
  setOpenFiles((prev) => {
    const i = prev.findIndex((f) => f.path === path);
    if (i < 0 || prev[i].content !== content || !prev[i].dirty) return prev;
    const next = prev.slice();
    next[i] = { ...next[i], dirty: false };
    return next;
  });
}

/**
 * Record the disk base hash for an open tab after a successful write, so the
 * save-time conflict guard measures against what actually hit disk. No-op if
 * the tab was closed meanwhile.
 */
function setFileBaseHash(path: string, baseHash: string): void {
  setOpenFiles((prev) => {
    const i = prev.findIndex((f) => f.path === path);
    if (i < 0 || prev[i].baseHash === baseHash) return prev;
    const next = prev.slice();
    next[i] = { ...next[i], baseHash };
    return next;
  });
}

/**
 * Adopt fresh on-disk content into an already-open tab and mark it clean —
 * used after a history restore or a sync conflict resolved on disk (e.g.
 * "keep theirs") so the buffer matches the canonical file and a follow-up
 * save can't resurrect the discarded version. No-op if the file isn't open.
 * When the content actually changed, `adoptGeneration` bumps so the active
 * tab's keyed editor remounts on the new content (a matching buffer only
 * needs its clean flag / base hash corrected — no remount, cursor kept).
 */
function adoptDiskContent(path: string, content: string, baseHash: string): void {
  setOpenFiles((prev) => {
    const i = prev.findIndex((f) => f.path === path);
    if (i < 0) return prev;
    const next = prev.slice();
    const gen = prev[i].adoptGeneration ?? 0;
    next[i] = {
      ...next[i],
      content,
      dirty: false,
      baseHash,
      adoptGeneration: prev[i].content === content ? gen : gen + 1,
    };
    return next;
  });
}

/**
 * Restore a snapshot's content into the editor: replace the buffer of an
 * already-open tab (marking it dirty) or open a new tab for it. Used by crash
 * recovery, where the orphaned file is frequently the root file that was
 * already opened on project load — so the target tab is usually already mounted.
 * Bump `adoptGeneration` when the content actually changed so the active tab's
 * keyed editor remounts on the recovered text; without it the already-mounted
 * CodeMirror keeps showing the stale on-disk buffer (its `value` prop is a
 * snapshot captured at mount) and the next keystroke/save would clobber the
 * recovered content with what is still displayed.
 */
function restoreFileContent(file: OpenFile): void {
  setOpenFiles((prev) => {
    const i = prev.findIndex((f) => f.path === file.path);
    if (i < 0) return [...prev, { ...file, dirty: true }];
    const next = prev.slice();
    const gen = prev[i].adoptGeneration ?? 0;
    next[i] = {
      ...next[i],
      content: file.content,
      dirty: true,
      adoptGeneration: prev[i].content === file.content ? gen : gen + 1,
    };
    return next;
  });
  if (activeIndex() < 0) setActiveIndex(0);
}

/**
 * Rename an open tab in place: repoint its absolute + relative path while
 * preserving the buffer content, dirty flag, and baseHash. The rename moved the
 * exact bytes on disk, so baseHash stays valid. The active tab's CodeMirror
 * remounts because `text-shell` keys it on `activeFile().path`. No-op if the
 * file isn't open (a rename from the tree on a non-open file needs no buffer
 * bookkeeping).
 */
function renameOpenFile(oldRel: string, newRel: string, newAbs: string): void {
  setOpenFiles((prev) => {
    const i = prev.findIndex((f) => f.relPath === oldRel);
    if (i < 0) return prev;
    const next = prev.slice();
    next[i] = { ...next[i], path: newAbs, relPath: newRel };
    return next;
  });
}

/**
 * Repoint every open tab under a moved/renamed directory: relPaths under
 * `oldDirRel` rebase onto `newDirRel`, and absolute paths are rebuilt from
 * `rootPath` with the same separator convention EditorScreen's joinPath uses
 * to open files, so tab identity survives the move. Content, dirty flag, and
 * baseHash are untouched — the move relocated the exact bytes.
 */
function remapOpenFilesUnderDir(
  oldDirRel: string,
  newDirRel: string,
  rootPath: string,
): void {
  const prefix = `${oldDirRel}/`;
  const sep = rootPath.includes("\\") ? "\\" : "/";
  const base = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  setOpenFiles((prev) =>
    prev.map((f) => {
      if (!f.relPath.startsWith(prefix)) return f;
      const newRel = newDirRel + f.relPath.slice(oldDirRel.length);
      return { ...f, relPath: newRel, path: base + newRel };
    }),
  );
}

/** Close whichever tab holds `relPath` (used after deleting a file). No-op if not open. */
function closeFileByRelPath(relPath: string): void {
  const i = openFiles().findIndex((f) => f.relPath === relPath);
  if (i >= 0) closeFile(i);
}

/** Close a tab by index. Adjusts activeIndex to a sibling. */
function closeFile(index: number): void {
  setOpenFiles((prev) => prev.filter((_, i) => i !== index));
  const remaining = openFiles().length;
  if (remaining === 0) {
    setActiveIndex(-1);
  } else {
    const i = activeIndex();
    // If we closed the active or anything to its left, shift index left.
    if (index <= i) setActiveIndex(Math.max(0, i - 1));
    // Otherwise activeIndex still points at the same tab.
  }
}

/** Reset all tabs (used when switching projects). */
function resetTabs(): void {
  setOpenFiles([]);
  setActiveIndex(-1);
}

/**
 * Clear compile status + last result on project switch. Without this a fresh
 * project renders the previous project's PDF (via `lastResult.outputPath`) and
 * shows its stale compile status/duration until its own first compile. Bumping
 * pdfVersion invalidates any cached PDF render for the now-null output path.
 */
function resetCompileState(): void {
  setCompileState("idle");
  setLastResult(null);
  clearLiveLog();
  bumpPdfVersion();
}

export {
  activateFileIfOpen,
  activeFile,
  activeIndex,
  adoptDiskContent,
  appendLiveLog,
  bumpPdfVersion,
  clearLiveLog,
  closeFile,
  closeFileByRelPath,
  compileState,
  liveLog,
  gotoSourceIntent,
  lastResult,
  markFileCleanIfUnchanged,
  openFile,
  openFiles,
  pdfScrollTarget,
  pdfVersion,
  project,
  remapOpenFilesUnderDir,
  renameOpenFile,
  resetCompileState,
  resetTabs,
  restoreFileContent,
  setActiveIndex,
  setCompileState,
  setFileBaseHash,
  setLastResult,
  setProject,
  updateActiveFile,
};

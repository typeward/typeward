import { createMemo, createSignal } from "solid-js";
import type { CompileResult, Project } from "~/adapters/types";

export interface OpenFile {
  /** Absolute path. */
  path: string;
  /** Path relative to project.rootPath. */
  relPath: string;
  content: string;
  dirty: boolean;
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
  generation: number;
}

const [project, setProject] = createSignal<Project | null>(null);
const [openFiles, setOpenFiles] = createSignal<OpenFile[]>([]);
const [activeIndex, setActiveIndex] = createSignal<number>(-1);
const [compileState, setCompileState] = createSignal<
  "idle" | "compiling" | "ok" | "error"
>("idle");
const [lastResult, setLastResult] = createSignal<CompileResult | null>(null);
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

export const requestGotoSource = (relPath: string, line: number): void => {
  _gotoGen++;
  setGotoSourceIntentInternal({ relPath, line, generation: _gotoGen });
};

const activeFile = createMemo<OpenFile | null>(() => {
  const i = activeIndex();
  const files = openFiles();
  return i >= 0 && i < files.length ? files[i] : null;
});

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
  const existing = openFiles().findIndex((f) => f.path === file.path);
  if (existing >= 0) {
    setActiveIndex(existing);
    return;
  }
  setOpenFiles((prev) => [...prev, file]);
  setActiveIndex(openFiles().length - 1);
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
 * Format-aware label for the logs/issues panel. Notebook projects keep
 * "Console" (interactive R session output); text-format projects use
 * "Logs" since the panel surfaces compile logs + diagnostics, not a
 * REPL.
 */
function consoleLabel(): string {
  const p = project();
  if (!p) return "Logs";
  return p.format === "rmarkdown" ? "Console" : "Logs";
}

export {
  activeFile,
  activeIndex,
  bumpPdfVersion,
  closeFile,
  compileState,
  consoleLabel,
  gotoSourceIntent,
  lastResult,
  openFile,
  openFiles,
  pdfScrollTarget,
  pdfVersion,
  project,
  resetTabs,
  setActiveIndex,
  setCompileState,
  setLastResult,
  setProject,
  updateActiveFile,
};

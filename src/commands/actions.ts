import { createSignal } from "solid-js";
import { describeIpcError } from "~/lib/errors";
import { notifyError, notifyInfo } from "~/lib/toast";
import type { EditorAdapter, Project, ProjectFormat } from "~/adapters/types";
import { LatexAdapter } from "~/adapters/latex/LatexAdapter";
import { effectiveBuild } from "~/adapters/latex/build-config";
import { matchSelectionToSource } from "~/lib/pdf-annotations/anchor";
import type { CreateThreadInput } from "~/lib/pdf-annotations/types";
import { lineRange } from "~/lib/reviews/lines";
import { createThread } from "~/lib/reviews/types";
import { addThread, requestReviewPanelIntent } from "~/stores/review-store";
import { TypstAdapter } from "~/adapters/typst/TypstAdapter";
import {
  pathRelativeToProjectRoot,
  resolveForwardWithWasmSynctex,
  resolveInverseWithWasmSynctex,
  syncForwardWithWasmSynctex,
} from "~/adapters/latex/synctex";
import { suffixWithConflict } from "~/integrations/cloud/core";
import { notifyLocalSave } from "~/integrations/cloud/init";
import * as ipc from "~/ipc";
import { sha256Hex } from "~/lib/hash";
import { recordError } from "~/lib/telemetry";
import {
  activeFile,
  bumpPdfVersion,
  compileState,
  lastResult,
  markFileCleanIfUnchanged,
  openFiles,
  project,
  requestGotoSource,
  requestPdfScroll,
  setCompileState,
  setFileBaseHash,
  setLastResult,
  type OpenFile,
} from "~/stores/editor-store";
import { currentCursorLine } from "~/stores/editor-view-store";
import { editorSettings } from "~/stores/settings-store";
import {
  consolePosition,
  editorLayout,
  focusMode,
  previewDetached,
  requestLogsTab,
  setEditorLayout,
  setFocusMode,
  setPreviewDetached,
  setPreviewMode,
} from "~/stores/ui-store";
import {
  activePane,
  paneTier,
  setLogsSheetOpen,
} from "~/stores/viewport-store";
import {
  navigateTo,
  setPaletteOpen,
  setRequestNewProject,
  togglePalette,
} from "./palette-store";
import {
  COMPILE_CANCELLED,
  beginCompileAttempt,
  cancelCompile,
  endCompileAttempt,
  setCompileRunners,
  wasCancelledEarly,
} from "./compile-runner";

/**
 * Single point that maps a project's format to its adapter. EditorScreen
 * imports this too. Backed by an exhaustive `Record<ProjectFormat, ...>` so
 * TypeScript forces an entry per format union member — add new adapters here
 * only, and a missed one is a compile error rather than a silent no-op.
 */
const ADAPTERS: Record<ProjectFormat, EditorAdapter> = {
  latex: LatexAdapter,
  typst: TypstAdapter,
};

export const adapterFor = (p: Project): EditorAdapter => ADAPTERS[p.format];

/** Re-exported from the LaTeX SyncTeX module; kept on this path for the
 *  inverse-search call site + its unit test. */
export { pathRelativeToProjectRoot };

// ----- Editor actions ------------------------------------------------------

export async function saveActiveFile(): Promise<void> {
  const file = activeFile();
  const p = project();
  if (!file || !p) return;
  await saveOpenFile(p, file);
}

// Per-file save serialization. Autosave (from the debounce timer) and an
// explicit Mod+S can target the same file concurrently; both run the
// read-compare-write conflict guard, and interleaving them would let one
// clobber the other's base-hash bookkeeping (or double-write the sidecar).
// Each save chains onto the file's in-flight tail so they run strictly in
// order. The stored tail never rejects, so a failed save can't wedge the chain.
const saveChainByPath = new Map<string, Promise<void>>();

/**
 * Serialize `work` behind any in-flight save of `key`. The stored tail never
 * rejects, so a failed save can't wedge the chain; the caller still sees the
 * real result/rejection via the returned promise.
 */
function chainOnPath<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (saveChainByPath.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  saveChainByPath.set(key, tail);
  void tail.finally(() => {
    if (saveChainByPath.get(key) === tail) saveChainByPath.delete(key);
  });
  return run;
}

/**
 * Persist one open buffer: conflict-guarded write, cloud push notify, and the
 * auto-compile branch. Shared by the explicit save path and autosave. `file` is
 * an immutable store snapshot, so its content/identity stay fixed across the
 * awaits even if the user keeps typing.
 */
export function saveOpenFile(p: Project, file: OpenFile): Promise<void> {
  return chainOnPath(file.path, () => performSave(p, file));
}

/**
 * Fire-and-forget version-history snapshots after a successful save. History
 * must never block or fail a save — the Rust side owns every policy gate
 * (dedupe, 5-minute throttle, extension/size limits), so this is a plain
 * notification; failures land in telemetry only. Bulletproof like
 * `recordError`: even a synchronous throw from the IPC layer can't reach the
 * save path.
 */
function recordHistorySnapshots(rootPath: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    try {
      void ipc.historyRecord(rootPath, rel).catch((e) => {
        recordError("history-record", `history snapshot failed for ${rel}`, e);
      });
    } catch (e) {
      recordError("history-record", `history snapshot failed for ${rel}`, e);
    }
  }
}

async function performSave(p: Project, file: OpenFile): Promise<void> {
  await writeBufferWithConflictGuard(p, file);
  notifyLocalSave(p.rootPath, [file.relPath]);
  recordHistorySnapshots(p.rootPath, [file.relPath]);
  // Auto-compile rides the save path only — compileActiveProject saves via
  // saveAllDirtyFiles, so this can't recurse, and its "already compiling" guard
  // absorbs rapid save bursts. LaTeX honors the per-project override; Typst uses
  // the global setting. Guard against a stale autosave flush (from a
  // switched-away tab) compiling a project the user has already left.
  const autoCompile =
    p.format === "latex" ? effectiveBuild(p).autoCompile : editorSettings().autoCompile;
  if (autoCompile && p.rootPath === project()?.rootPath) void compileActiveProject();
}

/**
 * Flush every dirty open buffer to disk. A multi-file LaTeX project compiles
 * `\input{}`-ed children from disk, so saving only the active tab would
 * compile stale content for every other edited file.
 */
export async function saveAllDirtyFiles(): Promise<void> {
  const p = project();
  if (!p) return;
  const saved: string[] = [];
  for (const file of openFiles()) {
    if (!file.dirty) continue;
    await chainOnPath(file.path, () => writeBufferWithConflictGuard(p, file));
    saved.push(file.relPath);
  }
  notifyLocalSave(p.rootPath, saved);
  recordHistorySnapshots(p.rootPath, saved);
}

/**
 * Write one buffer to disk, but first detect the case where the on-disk file
 * changed underneath the buffer since it was loaded (the classic save-after-
 * pull hazard: a cloud pull writes a collaborator's edit to disk while the
 * stale buffer still holds the old content). Blindly writing would silently
 * revert that edit, and because the sync engine already advanced its per-file
 * rev at pull time, its own conflict machinery can never recover it. When the
 * live disk hash differs from the hash the buffer was loaded from, preserve
 * the newer disk copy in a `.conflict-<ISO>` sidecar before overwriting, so
 * the other version stays recoverable and visible in the file tree.
 */
async function writeBufferWithConflictGuard(p: Project, file: OpenFile): Promise<void> {
  const savedContent = file.content;
  await preserveConflictingDiskCopy(p, file);
  try {
    await ipc.writeProjectTextFile(p.rootPath, file.relPath, savedContent);
  } catch (e) {
    recordError("save-failed", `write_project_text_file failed for ${file.relPath}`, e);
    throw e;
  }
  markFileCleanIfUnchanged(file.path, savedContent);
  setFileBaseHash(file.path, await sha256Hex(savedContent));
}

async function preserveConflictingDiskCopy(p: Project, file: OpenFile): Promise<void> {
  // No recorded origin hash (e.g. a conflict-inspection tab) → nothing to
  // compare against; fall through to a plain write.
  if (!file.baseHash) return;
  let disk: string;
  try {
    disk = await ipc.readProjectTextFile(p.rootPath, file.relPath);
  } catch {
    // File missing on disk (fresh create / deleted) — normal write path.
    return;
  }
  if (disk === file.content) return;
  const diskHash = await sha256Hex(disk);
  if (diskHash === file.baseHash) return; // disk unchanged since load — safe to overwrite
  let sidecarRel: string;
  try {
    sidecarRel = suffixWithConflict(file.relPath, Date.now());
  } catch (e) {
    recordError("save-conflict", `could not derive conflict path for ${file.relPath}`, e);
    return;
  }
  try {
    await ipc.writeProjectTextFile(p.rootPath, sidecarRel, disk);
    notifyError(
      "Overwrote newer changes on disk",
      `"${file.relPath}" had changed on disk since you opened it. The newer version was preserved as "${sidecarRel}".`,
    );
  } catch (e) {
    // Preserving the other copy failed — record it, but don't block the save;
    // the buffer content is what the user explicitly asked to persist.
    recordError("save-conflict", `failed to preserve disk copy of ${file.relPath}`, e);
  }
}

// Contract signals for the compile-loop UI (PdfViewer cancel button, elapsed
// pill, stale-preview hint). `compileStartedAt` is epoch ms while a compile
// runs and null once it settles; `lastSuccessAt` is the epoch ms of the last
// successful compile of this session.
const [compileStartedAt, setCompileStartedAtInternal] = createSignal<number | null>(null);
const [lastSuccessAt, setLastSuccessAtInternal] = createSignal<number | null>(null);
export { compileStartedAt, lastSuccessAt };

/**
 * Kill the in-flight compile's process tree. Safe no-op when idle. The
 * running `compileActiveProject` attempt observes the cancellation as its
 * IPC rejecting with the stable marker and returns the UI to idle itself.
 */
export async function cancelActiveCompile(): Promise<void> {
  if (compileState() !== "compiling") return;
  try {
    await cancelCompile();
  } catch (e) {
    recordError("compile-cancel", "compile_cancel IPC threw", e);
  }
}

/**
 * Surface a failed compile when no console surface can show it: in focus mode
 * the bottom drawer is hidden chrome, and in editor-only layout the preview
 * pane (home of the pdf-tab console) doesn't render — either way the only
 * feedback would be a status pill that focus mode also unmounts. The toast's
 * action restores a visible console and routes through the same logs-tab
 * intent the status-bar indicators use.
 */
function notifyCompileFailureIfHidden(errorCount: number): void {
  // Every layout where the console cannot currently paint: focus mode hides
  // the drawer; editor-only layout unmounts the preview pane (home of the
  // pdf-tab console) — as does a DETACHED preview, whose window is PDF-only;
  // tablet renders one pane at a time (drawer lives in the closed LogsSheet).
  // Tier semantics: only the ONE-pane tier hosts the drawer in a LogsSheet;
  // the two-pane tier (800-1023px) always renders the preview pane (pdf-tab
  // console works like desktop) and mounts the bottom drawer like desktop.
  const onePane = paneTier() === "one";
  const pdfTabHidden =
    consolePosition() === "pdf-tab" &&
    (editorLayout() === "editor" ||
      previewDetached() ||
      (onePane && activePane() !== "preview"));
  const drawerHidden =
    consolePosition() === "drawer" && (focusMode() || onePane);
  if (!pdfTabHidden && !drawerHidden) return;
  if (onePane) {
    // The sheet hosts the drawer on the single-pane tier regardless of
    // console position; auto-open it the way the desktop drawer reveals
    // itself. Skip the toast — the now-visible console IS the notification.
    setLogsSheetOpen(true);
    queueMicrotask(() => requestLogsTab("errors"));
    return;
  }
  const summary =
    errorCount > 0
      ? `${errorCount} error${errorCount === 1 ? "" : "s"} — open the log to jump to them`
      : "The build failed — open the log for details";
  notifyError("Compile failed", summary, {
    label: "View errors",
    run: () => {
      if (focusMode()) setFocusMode(false);
      if (paneTier() === "one") {
        setLogsSheetOpen(true);
        queueMicrotask(() => requestLogsTab("errors"));
        return;
      }
      if (consolePosition() === "pdf-tab") {
        // The console needs an attached preview pane to land in ("editor"
        // layout only exists on the three tier; two always shows preview).
        if (previewDetached()) setPreviewDetached(false);
        if (editorLayout() === "editor") setEditorLayout("split");
        setPreviewMode("console");
        queueMicrotask(() => requestLogsTab("errors"));
      } else {
        requestLogsTab("errors");
      }
    },
  });
}

/**
 * Orchestrates the full compile path: save-if-dirty, kick the adapter,
 * record results, push diagnostics into the store, and bump the PDF
 * version so the preview pane re-renders. Errors are reported via
 * telemetry — callers don't need to wrap in try/catch.
 */
export async function compileActiveProject(): Promise<void> {
  const p = project();
  if (!p) return;
  const adapter = adapterFor(p);
  // Guard against a second compile racing the first (Mod+Enter has no
  // disabled-state the way the Recompile button does); two latexmk runs in
  // one directory fight over aux files and corrupt the output.
  if (compileState() === "compiling") return;

  // adapter.compile is a long IPC await; the user can switch projects before
  // it resolves. Stamp the request with the active project's root and drop
  // the result if the project changed underneath us, so a stale compile can't
  // paint project A's PDF/status/diagnostics into project B.
  const compileRoot = p.rootPath;
  const isCurrent = () => project()?.rootPath === compileRoot;

  setCompileState("compiling");
  setCompileStartedAtInternal(Date.now());
  const compileId = beginCompileAttempt();
  try {
    // Inside the try so a failed save surfaces as a compile error in the
    // Issues tab instead of an unhandled rejection.
    await saveAllDirtyFiles();
    // Stop clicked during the save phase (or a shell-escape trust prompt the
    // adapter is about to raise) lands before Rust ever registers the id —
    // honor it here instead of starting the subprocess it meant to prevent.
    if (wasCancelledEarly(compileId)) throw COMPILE_CANCELLED;
    const result = await adapter.compile(p);
    if (!isCurrent()) return;
    setLastResult(result);
    setCompileState(result.ok ? "ok" : "error");
    if (result.ok) setLastSuccessAtInternal(Date.now());
    if (result.ok && result.outputPath) {
      bumpPdfVersion();
    } else {
      recordError(
        "compile-failed",
        `${p.format} compile exited non-zero`,
        result.log.slice(-2000),
      );
      notifyCompileFailureIfHidden(
        result.diagnostics.filter((d) => d.severity === "error").length,
      );
    }
  } catch (e) {
    if (!isCurrent()) return;
    // A user-initiated cancel is a return to idle, not an error: no
    // diagnostics, no drawer auto-open, just a quiet confirmation.
    if (describeIpcError(e) === COMPILE_CANCELLED) {
      setCompileState("idle");
      notifyInfo("Compile stopped");
      return;
    }
    setLastResult({
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: describeIpcError(e),
          file: p.rootFile,
          line: 1,
          source: "compile",
        },
      ],
      log: describeIpcError(e),
      durationMs: 0,
    });
    setCompileState("error");
    recordError("compile-failed", "compile threw before producing a result", e);
    notifyCompileFailureIfHidden(1);
  } finally {
    // Settle bookkeeping runs on every path — including the stale-project
    // early returns — so the elapsed pill and cancel handle can't leak.
    endCompileAttempt(compileId);
    setCompileStartedAtInternal(null);
  }
}

/**
 * Mod+S action: save every dirty buffer, then compile. Saving first (rather
 * than relying on compile's internal save) guarantees Ctrl+S during an active
 * compile still persists — `compileActiveProject` returns early on its
 * compiling-guard, but the buffers are already on disk for the next run. No
 * double-compile: `saveAllDirtyFiles` never triggers auto-compile (only the
 * per-file save path does), so compile fires exactly once here.
 */
export async function saveAndCompileActiveProject(): Promise<void> {
  await saveAllDirtyFiles();
  void compileActiveProject();
}

// ----- Global actions ------------------------------------------------------

export const openPalette = (): void => {
  setPaletteOpen(true);
};
export const closePalette = (): void => {
  setPaletteOpen(false);
};
export const toggleCommandPalette = (): void => {
  togglePalette();
};

/**
 * Opens the New Project dialog. If the user isn't on the Projects screen
 * yet, we route them there first — the dialog is owned by ProjectsScreen,
 * which reads `requestNewProject` and opens its dialog on mount or when
 * the flag flips.
 */
export const openNewProjectDialog = (): void => {
  setRequestNewProject(true);
  navigateTo("/projects");
};

export const openSettings = (): void => navigateTo("/settings");
export const openProjects = (): void => navigateTo("/projects");

// ----- SyncTeX actions -----------------------------------------------------

/**
 * Forward search: cursor in editor → PDF location. Requires:
 *   - A compiled PDF (`lastResult.outputPath`)
 *   - The active file is part of the open project
 *   - SyncTeX data from the active compile engine
 *
 * The user-visible feedback is the PdfViewer's pulse-ribbon highlight at
 * the target Y. We silently no-op (rather than erroring loudly) when any
 * precondition fails — Mod+J on an un-compiled doc is a common slip.
 */
export async function syncForwardFromCursor(): Promise<void> {
  const p = project();
  if (!p) return;
  const file = activeFile();
  if (!file) return;
  const result = lastResult();
  if (!result?.outputPath) return;
  const line = currentCursorLine();
  if (!line) return;

  if (effectiveBuild(p).engine === "texlive-wasm") {
    await syncForwardWithWasmSynctex(p, result.outputPath, file.relPath, line);
    return;
  }

  try {
    const loc = await ipc.synctexForward({
      projectRoot: p.rootPath,
      pdfPath: result.outputPath,
      sourceFile: file.relPath,
      line,
    });
    if (loc) {
      requestPdfScroll(loc.page, loc.y);
    }
  } catch (e) {
    recordError("synctex-forward", "synctex_forward IPC threw", e);
  }
}

/**
 * Inverse-search lookup ONLY (no navigation): PDF (page, x, y) → source
 * (relPath, line), or null. Split out so the PDF selection chip can anchor a
 * new thread to the clicked source line without also moving the editor cursor.
 * Branches on the active engine (wasm reader vs the synctex CLI).
 */
export async function resolveInverse(
  pageNum: number,
  x: number,
  y: number,
): Promise<{ relPath: string; line: number } | null> {
  const p = project();
  if (!p) return null;
  const result = lastResult();
  if (!result?.outputPath) return null;

  if (effectiveBuild(p).engine === "texlive-wasm") {
    return resolveInverseWithWasmSynctex(p, result.outputPath, pageNum, x, y);
  }

  try {
    const loc = await ipc.synctexInverse({
      projectRoot: p.rootPath,
      pdfPath: result.outputPath,
      page: pageNum,
      x,
      y,
    });
    if (!loc) return null;
    const relPath = pathRelativeToProjectRoot(p.rootPath, loc.file);
    return relPath ? { relPath, line: loc.line } : null;
  } catch (e) {
    recordError("synctex-inverse", "synctex_inverse IPC threw", e);
    return null;
  }
}

/**
 * Forward-search lookup ONLY (no scroll): source (relPath, line) → PDF
 * (page, y in points), or null. The annotation mapper (E10c) uses this to place
 * review/TODO highlights; the cursor forward-search still scrolls via
 * `syncForwardFromCursor`.
 */
export async function resolveForward(
  p: Project,
  outputPath: string,
  relPath: string,
  line: number,
): Promise<{ page: number; y: number } | null> {
  if (effectiveBuild(p).engine === "texlive-wasm") {
    return resolveForwardWithWasmSynctex(p, outputPath, relPath, line);
  }
  try {
    const loc = await ipc.synctexForward({
      projectRoot: p.rootPath,
      pdfPath: outputPath,
      sourceFile: relPath,
      line,
    });
    return loc ? { page: loc.page, y: loc.y } : null;
  } catch (e) {
    recordError("synctex-forward", "synctex_forward IPC threw", e);
    return null;
  }
}

/**
 * Inverse search: PDF click → cursor in source. Routes through the goto-source
 * intent signal so EditorScreen can open the file if needed.
 */
export async function syncInverseFromPdfClick(
  pageNum: number,
  x: number,
  y: number,
  selectedText?: string,
): Promise<void> {
  const loc = await resolveInverse(pageNum, x, y);
  if (!loc) return;
  if (selectedText) {
    const p = project();
    const content = p ? await readProjectSource(p, loc.relPath) : null;
    const match =
      content !== null
        ? matchSelectionToSource(content, loc.line, selectedText)
        : null;
    if (match) {
      requestGotoSource(loc.relPath, loc.line, {
        from: match.fromOffset,
        to: match.toOffset,
      });
      return;
    }
  }
  requestGotoSource(loc.relPath, loc.line);
}

/**
 * Source text for a project file — live buffer preferred (its offsets match the
 * review store), disk fallback; null if unreadable. Shared by the annotation
 * mapper and PDF-selection thread creation.
 */
export async function readProjectSource(p: Project, rel: string): Promise<string | null> {
  const buf = openFiles().find((f) => f.relPath === rel);
  if (buf) return buf.content;
  try {
    return await ipc.readProjectTextFile(p.rootPath, rel);
  } catch {
    return null;
  }
}

/**
 * Create a review/TODO thread from a PDF text selection (E10b/E11). SyncTeX
 * inverse resolves the coarse source line; the fuzzy word matcher narrows to the
 * selected words, falling back to the whole line. Opens the review panel
 * targeted at the new thread. Shared by the in-pane viewer and the detached
 * preview window's bridge.
 */
export async function createThreadFromPdfSelection(input: CreateThreadInput): Promise<void> {
  const p = project();
  if (!p) return;
  const loc = await resolveInverse(input.page, input.x, input.y);
  if (!loc) {
    notifyError(
      "Couldn't anchor the comment",
      "SyncTeX couldn't map that selection to source. Recompile with SyncTeX enabled.",
    );
    return;
  }
  const content = await readProjectSource(p, loc.relPath);
  if (content === null) {
    notifyError("Couldn't anchor the comment", `Could not read ${loc.relPath}.`);
    return;
  }
  const match = matchSelectionToSource(content, loc.line, input.selectedText);
  const range = match
    ? { from: match.fromOffset, to: match.toOffset }
    : lineRange(content, loc.line);
  const anchorText = content.slice(range.from, range.to).trim() || input.selectedText;
  const thread = createThread(
    loc.relPath,
    range.from,
    range.to,
    anchorText,
    "You",
    input.body,
    input.kind,
  );
  addThread(thread);
  requestReviewPanelIntent(thread.id, input.kind === "todo" ? "todo" : "review");
}

// Inject the orchestration into the compile-runner leaf so adapter build/sync
// commands can trigger it without importing this module (see compile-runner.ts).
setCompileRunners({
  compile: compileActiveProject,
  syncForward: syncForwardFromCursor,
});

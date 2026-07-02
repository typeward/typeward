import { describeIpcError } from "~/lib/errors";
import { notifyInfo } from "~/lib/toast";
import type { EditorAdapter, Project, ProjectFormat } from "~/adapters/types";
import { LatexAdapter } from "~/adapters/latex/LatexAdapter";
import { TypstAdapter } from "~/adapters/typst/TypstAdapter";
import {
  pathRelativeToProjectRoot,
  syncForwardWithWasmSynctex,
  syncInverseWithWasmSynctex,
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
import { compileEngine, editorSettings } from "~/stores/settings-store";
import {
  navigateTo,
  setPaletteOpen,
  setRequestNewProject,
  togglePalette,
} from "./palette-store";
import { setCompileRunners } from "./compile-runner";

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
  // `file` is an immutable store snapshot, so its content/identity stay fixed
  // across the awaits below even if the user keeps typing.
  await writeBufferWithConflictGuard(p, file);
  notifyLocalSave(p.rootPath, [file.relPath]);
  // Auto-compile rides the explicit save path only — compileActiveProject
  // saves via saveAllDirtyFiles, so this can't recurse, and its
  // "already compiling" guard absorbs rapid save bursts.
  if (editorSettings().autoCompile) void compileActiveProject();
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
    await writeBufferWithConflictGuard(p, file);
    saved.push(file.relPath);
  }
  notifyLocalSave(p.rootPath, saved);
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
    notifyInfo(
      "Saved over newer changes",
      `"${file.relPath}" had changed on disk since you opened it. That version was kept as "${sidecarRel}".`,
    );
  } catch (e) {
    // Preserving the other copy failed — record it, but don't block the save;
    // the buffer content is what the user explicitly asked to persist.
    recordError("save-conflict", `failed to preserve disk copy of ${file.relPath}`, e);
  }
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

  // adapter.compile is an un-cancellable IPC await; the user can switch
  // projects before it resolves. Stamp the request with the active project's
  // root and drop the result if the project changed underneath us, so a stale
  // compile can't paint project A's PDF/status/diagnostics into project B.
  const compileRoot = p.rootPath;
  const isCurrent = () => project()?.rootPath === compileRoot;

  setCompileState("compiling");
  try {
    // Inside the try so a failed save surfaces as a compile error in the
    // Issues tab instead of an unhandled rejection.
    await saveAllDirtyFiles();
    const result = await adapter.compile(p);
    if (!isCurrent()) return;
    setLastResult(result);
    setCompileState(result.ok ? "ok" : "error");
    if (result.ok && result.outputPath) {
      bumpPdfVersion();
    } else {
      recordError(
        "compile-failed",
        `${p.format} compile exited non-zero`,
        result.log.slice(-2000),
      );
    }
  } catch (e) {
    if (!isCurrent()) return;
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
  }
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

  if (compileEngine() === "texlive-wasm") {
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
 * Inverse search: PDF click → cursor in source. Translates an absolute
 * source path returned by SyncTeX into a project-relative one and routes through the
 * goto-source intent signal so EditorScreen can open the file if needed.
 */
export async function syncInverseFromPdfClick(
  pageNum: number,
  x: number,
  y: number,
): Promise<void> {
  const p = project();
  if (!p) return;
  const result = lastResult();
  if (!result?.outputPath) return;

  if (compileEngine() === "texlive-wasm") {
    await syncInverseWithWasmSynctex(p, result.outputPath, pageNum, x, y);
    return;
  }

  try {
    const loc = await ipc.synctexInverse({
      projectRoot: p.rootPath,
      pdfPath: result.outputPath,
      page: pageNum,
      x,
      y,
    });
    if (!loc) return;
    const relPath = pathRelativeToProjectRoot(p.rootPath, loc.file);
    if (relPath) requestGotoSource(relPath, loc.line);
  } catch (e) {
    recordError("synctex-inverse", "synctex_inverse IPC threw", e);
  }
}

// Inject the orchestration into the compile-runner leaf so adapter build/sync
// commands can trigger it without importing this module (see compile-runner.ts).
setCompileRunners({
  compile: compileActiveProject,
  syncForward: syncForwardFromCursor,
});

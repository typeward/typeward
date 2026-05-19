import type { EditorAdapter, Project } from "~/adapters/types";
import { LatexAdapter } from "~/adapters/latex/LatexAdapter";
import { MarkdownAdapter } from "~/adapters/markdown/MarkdownAdapter";
import { RmarkdownAdapter } from "~/adapters/rmarkdown/RmarkdownAdapter";
import { TypstAdapter } from "~/adapters/typst/TypstAdapter";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";
import {
  activeFile,
  bumpPdfVersion,
  lastResult,
  project,
  requestGotoSource,
  requestPdfScroll,
  setCompileState,
  setLastResult,
  updateActiveFile,
} from "~/stores/editor-store";
import { currentCursorLine } from "~/stores/editor-view-store";
import {
  navigateTo,
  setPaletteOpen,
  setRequestNewProject,
  togglePalette,
} from "./palette-store";

/**
 * Single point that maps a project's format to its adapter. EditorScreen's
 * `adapterForFormat` mirrors this — keep them in lockstep when new
 * adapters land.
 */
const adapterFor = (p: Project): EditorAdapter | null => {
  if (p.format === "latex") return LatexAdapter;
  if (p.format === "markdown") return MarkdownAdapter;
  if (p.format === "typst") return TypstAdapter;
  if (p.format === "rmarkdown") return RmarkdownAdapter;
  return null;
};

// ----- Editor actions ------------------------------------------------------

export async function saveActiveFile(): Promise<void> {
  const file = activeFile();
  const p = project();
  if (!file || !p) return;
  await ipc.writeProjectTextFile(p.rootPath, file.relPath, file.content);
  updateActiveFile({ dirty: false });
}

/**
 * Orchestrates the full compile path: save-if-dirty, kick the adapter,
 * record results, push diagnostics into the store, and bump the PDF
 * version so the PreviewProvider re-renders. Errors are reported via
 * telemetry — callers don't need to wrap in try/catch.
 */
export async function compileActiveProject(): Promise<void> {
  const p = project();
  if (!p) return;
  const adapter = adapterFor(p);
  if (!adapter) return;

  if (activeFile()?.dirty) {
    await saveActiveFile();
  }
  setCompileState("compiling");
  try {
    const result = await adapter.compile(p);
    setLastResult(result);
    setCompileState(result.ok ? "ok" : "error");
    if (result.ok) {
      bumpPdfVersion();
    } else {
      recordError(
        "compile-failed",
        `${p.format} compile exited non-zero`,
        result.log.slice(-2000),
      );
    }
  } catch (e) {
    setLastResult({
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: String(e),
          file: p.rootFile,
          line: 1,
          source: "compile",
        },
      ],
      log: String(e),
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
 *   - synctex CLI installed (IPC returns null otherwise)
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
    // Telemetry only — SyncTeX is best-effort. Don't surface to the user.
    recordError("synctex-forward", "synctex_forward IPC threw", e);
  }
}

/**
 * Inverse search: PDF click → cursor in source. Translates an absolute
 * source path returned by synctex into a project-relative one (synctex
 * emits absolute paths on every platform) and routes through the
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

  try {
    const loc = await ipc.synctexInverse({
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

/**
 * Best-effort: convert an absolute source path to a path relative to the
 * project root. SyncTeX emits the source path as the engine resolved it,
 * which may include normalized casing or symlink resolution — we compare
 * case-insensitively on Windows where the FS is case-insensitive anyway.
 * Returns null if the absolute path doesn't live under the project.
 */
export function pathRelativeToProjectRoot(root: string, abs: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const a = norm(abs);
  const caseInsensitive =
    typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent || navigator.platform || "");
  const cmp = (x: string, y: string) =>
    caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y;
  if (cmp(a, r)) return null;
  if (!cmp(a.slice(0, r.length), r) || a.charAt(r.length) !== "/") {
    return null;
  }
  const rest = a.slice(r.length + 1);
  return rest || null;
}

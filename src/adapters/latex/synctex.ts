import type { Project } from "~/adapters/types";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";
import { requestGotoSource, requestPdfScroll } from "~/stores/editor-store";

/**
 * SyncTeX glue that only makes sense for LaTeX (Typst has no SyncTeX) and, in
 * particular, the texlive-wasm engine's in-browser SyncTeX reader. It lives
 * next to the LaTeX adapter rather than in the format-agnostic actions module
 * so a second format or engine doesn't have to thread its knowledge through the
 * shared orchestrator.
 *
 * `pathRelativeToProjectRoot` is generic path logic, but it is only used by the
 * SyncTeX paths (system + wasm), so it is owned here and re-exported from
 * commands/actions for the inverse-search entry point + its unit test.
 */

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

function synctexSourceToProjectRel(projectRoot: string, sourceFile: string): string | null {
  const fromRoot = pathRelativeToProjectRoot(projectRoot, sourceFile);
  if (fromRoot) return fromRoot;

  const normalized = sourceFile.replace(/\\/g, "/");
  if (normalized.startsWith("/project/")) return normalized.slice("/project/".length);
  if (!normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized)) return normalized;
  return null;
}

function replaceExt(filename: string, newExt: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return `${filename}.${newExt}`;
  return `${filename.slice(0, dot)}.${newExt}`;
}

async function readWasmSynctex(
  projectRoot: string,
  outputPath: string,
): Promise<import("texlive-wasm").SynctexLookup | null> {
  const pdfRel = pathRelativeToProjectRoot(projectRoot, outputPath);
  if (!pdfRel) return null;

  const synctexRel = replaceExt(pdfRel, "synctex");
  for (const candidate of [`${synctexRel}.gz`, synctexRel]) {
    try {
      const bytes = await ipc.readProjectBinaryFile(projectRoot, candidate);
      const { createSynctex } = await import("texlive-wasm");
      return await createSynctex(bytes);
    } catch {
      // Try the alternate gzip/plain SyncTeX spelling.
    }
  }
  return null;
}

/** Lookup-only forward: (source line) → (page, y in PDF pts), or null. Split
 *  from the scroll action so the annotation mapper can reuse it. */
export async function resolveForwardWithWasmSynctex(
  p: Project,
  outputPath: string,
  relPath: string,
  line: number,
): Promise<{ page: number; y: number } | null> {
  try {
    const lookup = await readWasmSynctex(p.rootPath, outputPath);
    const hit = lookup?.forward(relPath, line)[0];
    return hit ? { page: hit.page, y: hit.y } : null;
  } catch (e) {
    recordError("synctex-forward", "wasm synctex forward lookup threw", e);
    return null;
  }
}

export async function syncForwardWithWasmSynctex(
  p: Project,
  outputPath: string,
  relPath: string,
  line: number,
): Promise<void> {
  const hit = await resolveForwardWithWasmSynctex(p, outputPath, relPath, line);
  if (hit) requestPdfScroll(hit.page, hit.y);
}

/** Lookup-only inverse: (page, x, y) → (relPath, line), or null. Split from the
 *  goto action so the PDF selection chip can anchor without navigating. */
export async function resolveInverseWithWasmSynctex(
  p: Project,
  outputPath: string,
  pageNum: number,
  x: number,
  y: number,
): Promise<{ relPath: string; line: number } | null> {
  try {
    const lookup = await readWasmSynctex(p.rootPath, outputPath);
    const hit = lookup?.reverse(pageNum, x, y)[0];
    if (!hit) return null;
    const relPath = synctexSourceToProjectRel(p.rootPath, hit.file);
    return relPath ? { relPath, line: hit.line } : null;
  } catch (e) {
    recordError("synctex-inverse", "wasm synctex inverse lookup threw", e);
    return null;
  }
}

export async function syncInverseWithWasmSynctex(
  p: Project,
  outputPath: string,
  pageNum: number,
  x: number,
  y: number,
): Promise<void> {
  const hit = await resolveInverseWithWasmSynctex(p, outputPath, pageNum, x, y);
  if (hit) requestGotoSource(hit.relPath, hit.line);
}

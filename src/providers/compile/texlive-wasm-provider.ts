import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import type { CompileResult, Project } from "~/adapters/types";
import * as ipc from "~/ipc";
import {
  DOWNLOAD_HINT,
  getEngineBundle,
  texliveWasmAssetStatus,
  type AssetStatus,
} from "~/providers/compile/texlive-wasm-assets";

const TEXT_EXTS = new Set([
  ".tex", ".bib", ".cls", ".sty", ".bst", ".def",
  ".ldf", ".fd", ".cnf", ".clo", ".aux",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".pdf", ".gif", ".eps",
]);

// `.typeward` is intentionally NOT skipped: the reference aggregator writes
// the unified `.typeward/citations/library.bib` there and the walker must
// pick it up for `\cite{}` to resolve on mobile. Its `build/` output is still
// pruned by SKIP_DIRS; `snapshots/` holds only `.snap` files, which match no
// read extension, so it's walked but contributes nothing.
const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "build", "out", "dist",
]);

interface AdditionalFile {
  path: string;
  content: string | Uint8Array;
}

function joinPath(...segments: string[]): string {
  if (segments.length === 0) return "";
  const sep = segments[0].includes("\\") ? "\\" : "/";
  return segments
    .map((s, i) => {
      let r = s.replace(/[\/\\]+$/g, "");
      if (i > 0) r = r.replace(/^[\/\\]+/g, "");
      return r;
    })
    .filter(Boolean)
    .join(sep);
}

const replaceExt = (filename: string, newExt: string): string => {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return `${filename}.${newExt}`;
  return `${filename.slice(0, dot)}.${newExt}`;
};

const READ_BATCH_SIZE = 20;

async function collectProjectFiles(
  rootPath: string,
  rootRelFile: string,
): Promise<AdditionalFile[]> {
  const collected: AdditionalFile[] = [];
  const queue: { abs: string; rel: string }[] = [{ abs: rootPath, rel: "" }];
  let totalBytes = 0;
  const FILE_CAP = 200;
  const BYTE_CAP = 10 * 1024 * 1024;

  const pending: Array<{ relPath: string; isText: boolean }> = [];

  while (queue.length > 0) {
    const { abs, rel } = queue.shift()!;
    let entries: DirEntry[];
    try {
      entries = await readDir(abs);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name) continue;
      if (e.name.startsWith(".") && e.name !== ".typeward") continue;
      if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;

      const childAbs = joinPath(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (e.isDirectory) {
        queue.push({ abs: childAbs, rel: childRel });
        continue;
      }

      if (childRel === rootRelFile) continue;

      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      const isText = TEXT_EXTS.has(ext);
      const isBinary = !isText && BINARY_EXTS.has(ext);
      if (!isText && !isBinary) continue;

      pending.push({ relPath: childRel, isText });
      if (pending.length >= FILE_CAP) break;
    }
    if (pending.length >= FILE_CAP) break;
  }

  for (let i = 0; i < pending.length; i += READ_BATCH_SIZE) {
    const batch = pending.slice(i, i + READ_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async ({ relPath, isText }) => {
        if (isText) {
          const text = await ipc.readProjectTextFile(rootPath, relPath);
          return { path: relPath, content: text, size: text.length };
        }
        const bytes = await ipc.readProjectBinaryFile(rootPath, relPath);
        return { path: relPath, content: bytes as string | Uint8Array, size: bytes.byteLength };
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      totalBytes += r.value.size;
      if (totalBytes > BYTE_CAP) return collected;
      collected.push({ path: r.value.path, content: r.value.content });
      if (collected.length >= FILE_CAP) return collected;
    }
  }
  return collected;
}

/** Helper engines this document will actually invoke but whose artifact wasn't
 * downloaded — compiling anyway would either throw inside the engine worker or
 * silently drop the bibliography/index. */
async function missingHelpers(
  status: AssetStatus,
  files: AdditionalFile[],
): Promise<string[]> {
  const { willRunBibtex, willRunBiber } = await import("texlive-wasm");
  const needed: string[] = [];
  if (!status.engines.bibtexu && willRunBibtex(files)) needed.push("bibtexu");
  if (!status.engines.biber && willRunBiber(files)) needed.push("biber");
  if (
    !status.engines.makeindex &&
    files.some(
      (f) =>
        typeof f.content === "string" &&
        (f.content.includes("\\makeindex") || f.content.includes("\\printindex")),
    )
  ) {
    needed.push("makeindex");
  }
  return needed;
}

function failure(
  project: Project,
  message: string,
  started: number,
): CompileResult {
  return {
    ok: false,
    diagnostics: [{
      severity: "error",
      message,
      file: project.rootFile,
      line: 1,
    }],
    log: message,
    durationMs: Math.round(performance.now() - started),
  };
}

export async function compileWithTexliveWasm(
  project: Project,
): Promise<CompileResult> {
  const started = performance.now();

  const status = await texliveWasmAssetStatus();
  if (!status.ok) {
    return failure(project, status.message, started);
  }

  let input: string;
  try {
    input = await ipc.readProjectTextFile(project.rootPath, project.rootFile);
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{
        severity: "error",
        message: `failed to read ${project.rootFile}: ${String(e)}`,
        file: project.rootFile,
        line: 1,
      }],
      log: String(e),
      durationMs: Math.round(performance.now() - started),
    };
  }

  let additionalFiles: AdditionalFile[] = [];
  try {
    additionalFiles = await collectProjectFiles(project.rootPath, project.rootFile);
  } catch {
    additionalFiles = [];
  }

  const files = [
    { path: project.rootFile, content: input },
    ...additionalFiles,
  ];

  const needed = await missingHelpers(status, files);
  if (needed.length > 0) {
    return failure(
      project,
      `This document needs the ${needed.join(" and ")} engine${needed.length > 1 ? "s" : ""}, ` +
        `which ${needed.length > 1 ? "are" : "is"} not bundled with this build. ${DOWNLOAD_HINT}`,
      started,
    );
  }

  let result: import("texlive-wasm").LatexmkResult;
  try {
    const { latexmk } = await import("texlive-wasm");
    const { tex, engineConfig } = await getEngineBundle();
    result = await latexmk({
      engine: "pdflatex",
      mainTex: project.rootFile,
      files,
      bibtex: status.engines.bibtexu ? "auto" : false,
      biber: status.engines.biber ? "auto" : false,
      makeindex: status.engines.makeindex ? "auto" : false,
      rerun: "auto",
      handles: { tex },
      engineConfig,
    });
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{
        severity: "error",
        message: `texlive-wasm threw: ${String(e instanceof Error ? e.message : e)}`,
        file: project.rootFile,
        line: 1,
      }],
      log: String(e instanceof Error ? e.stack ?? e.message : e),
      durationMs: Math.round(performance.now() - started),
    };
  }

  let outputPath: string | undefined;
  if (result.success && result.pdf) {
    const buildRelDir = joinPath(".typeward", "build");
    const outputRelPath = joinPath(buildRelDir, replaceExt(project.rootFile, "pdf"));
    outputPath = joinPath(project.rootPath, outputRelPath);
    try {
      await ipc.writeProjectBinaryFile(project.rootPath, outputRelPath, result.pdf);
    } catch (e) {
      return {
        ok: false,
        diagnostics: [{
          severity: "error",
          message: `compile succeeded but writing the PDF to disk failed: ${String(e)}`,
          file: project.rootFile,
          line: 1,
        }],
        log: result.log,
        durationMs: Math.round(performance.now() - started),
      };
    }

    if (result.synctex && result.synctex.byteLength > 0) {
      const isGzipped =
        result.synctex.byteLength >= 2 &&
        result.synctex[0] === 0x1f &&
        result.synctex[1] === 0x8b;
      const synctexRelPath = joinPath(
        buildRelDir,
        replaceExt(project.rootFile, isGzipped ? "synctex.gz" : "synctex"),
      );
      try {
        await ipc.writeProjectBinaryFile(project.rootPath, synctexRelPath, result.synctex);
      } catch { /* soft fail */ }
    }
  }

  let diagnostics: CompileResult["diagnostics"] = [];
  try {
    const parsed = await ipc.parseLatexLog(result.log, project.rootFile);
    diagnostics = parsed.map((d) => ({
      severity: d.severity,
      message: d.message,
      file: d.file,
      line: d.line,
    }));
  } catch { /* best-effort */ }

  return {
    ok: result.success,
    outputPath,
    diagnostics,
    log: result.log,
    durationMs: Math.round(performance.now() - started),
  };
}

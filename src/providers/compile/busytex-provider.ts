import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import type { CompileResult, Project } from "~/adapters/types";
import * as ipc from "~/ipc";

/**
 * busytex (TeX Live 2026 WASM) CompileProvider.
 *
 * The runtime is initialized lazily on first compile so the ~32MB WASM
 * bridge + ~90-400MB data download don't penalize sessions that never
 * touch this engine. Assets must be downloaded once with
 * `npx texlyre-busytex download-assets ./public/core` before this provider
 * can compile anything — `public/core/busytex/` is mapped to `/core/busytex`
 * at runtime by Vite, matching the package's default `busytexBasePath`.
 *
 * Multi-file projects: the provider walks the project tree (skipping
 * `.typeward`, `.git`, `node_modules`, build artifacts) and ships every
 * LaTeX-relevant file as `additionalFiles` so `\input{...}`,
 * `\include{...}`, `\bibliography{...}`, and `\includegraphics{...}`
 * resolve against busytex's in-memory FS. Text files (`.tex`, `.bib`,
 * `.cls`, etc.) are read as UTF-8; figures (`.png`, `.jpg`, `.jpeg`,
 * `.pdf`, `.gif`, `.eps`) are read as Uint8Array — `FileInput.content`
 * accepts both.
 *
 * SyncTeX: the engine returns a `synctex` Uint8Array alongside the PDF.
 * We persist it next to the PDF (as `.synctex.gz` when it has the gzip
 * magic header `1f 8b`, else `.synctex`) so the existing synctex CLI
 * shell-out in `src-tauri/src/synctex.rs` resolves forward/inverse
 * search against busytex-produced PDFs the same way it does for system
 * TeX / Tectonic. Tablets without the synctex CLI degrade silently to
 * "no sync" via that module's Ok(None) path.
 */

let runnerPromise: Promise<unknown> | null = null;
let pdfLatexPromise: Promise<unknown> | null = null;

const getRunner = async (): Promise<unknown> => {
  if (runnerPromise) return runnerPromise;
  runnerPromise = (async () => {
    const mod = await import("texlyre-busytex");
    const runner = new mod.BusyTexRunner({
      busytexBasePath: "/core/busytex",
      verbose: false,
      engineMode: "pdftex",
    });
    await runner.initialize(true);
    return runner;
  })();
  return runnerPromise;
};

const getPdfLatex = async (): Promise<{
  compile: (opts: unknown) => Promise<{
    success: boolean;
    pdf?: Uint8Array;
    synctex?: Uint8Array;
    log: string;
    exitCode: number;
  }>;
}> => {
  if (pdfLatexPromise) return pdfLatexPromise as Promise<never>;
  pdfLatexPromise = (async () => {
    const [mod, runner] = await Promise.all([
      import("texlyre-busytex"),
      getRunner(),
    ]);
    return new mod.PdfLatex(runner as never, false);
  })();
  return pdfLatexPromise as Promise<never>;
};

const joinPath = (parent: string, ...rest: string[]): string => {
  const useBackslash = parent.includes("\\");
  const sep = useBackslash ? "\\" : "/";
  return [parent, ...rest]
    .map((p) => p.replace(/[\/\\]+$/g, ""))
    .join(sep);
};

const replaceExt = (filename: string, newExt: string): string => {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return `${filename}.${newExt}`;
  return `${filename.slice(0, dot)}.${newExt}`;
};

/**
 * Friendlier error than busytex's generic init failure when assets are
 * missing — checks for the most common ones up front.
 */
const TEXT_EXTS = new Set([
  ".tex",
  ".bib",
  ".cls",
  ".sty",
  ".bst",
  ".def",
  ".ldf",
  ".fd",
  ".cnf",
  ".clo",
  ".aux",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".gif",
  ".eps",
]);

const SKIP_DIRS = new Set([
  ".typeward",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "build",
  "out",
  "dist",
]);

interface AdditionalFile {
  path: string;
  content: string | Uint8Array;
}

/**
 * Walks the project root and returns every LaTeX-relevant file
 * (excluding the root entry, which is shipped as `input`). Capped at
 * 200 files / 10 MB to keep the worker payload sane — projects bigger
 * than that should rely on system-tex or tectonic, not busytex.
 *
 * Text files (.tex/.bib/...) are read as UTF-8; figures (.png/.jpg/...)
 * as raw bytes. The byte cap is computed against the post-read payload
 * so a single huge image doesn't silently exclude every other file.
 */
async function collectProjectFiles(
  rootPath: string,
  rootRelFile: string,
): Promise<AdditionalFile[]> {
  const collected: AdditionalFile[] = [];
  const queue: { abs: string; rel: string }[] = [{ abs: rootPath, rel: "" }];
  let totalBytes = 0;
  const FILE_CAP = 200;
  const BYTE_CAP = 10 * 1024 * 1024;

  while (queue.length > 0 && collected.length < FILE_CAP) {
    const { abs, rel } = queue.shift()!;
    let entries: DirEntry[];
    try {
      entries = await readDir(abs);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name) continue;
      if (e.name.startsWith(".") && e.name !== ".typeward") {
        // Skip dotfiles other than .typeward (which we filter via SKIP_DIRS).
        continue;
      }
      if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;

      const childAbs = joinPath(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (e.isDirectory) {
        queue.push({ abs: childAbs, rel: childRel });
        continue;
      }

      // Skip the root file — it goes through as `input` separately.
      if (childRel === rootRelFile) continue;

      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      const isText = TEXT_EXTS.has(ext);
      const isBinary = !isText && BINARY_EXTS.has(ext);
      if (!isText && !isBinary) continue;

      let content: string | Uint8Array;
      let size: number;
      try {
        if (isText) {
          const text = await ipc.readProjectTextFile(rootPath, childRel);
          content = text;
          size = text.length;
        } else {
          const bytes = await ipc.readProjectBinaryFile(rootPath, childRel);
          content = bytes;
          size = bytes.byteLength;
        }
      } catch {
        continue;
      }
      totalBytes += size;
      if (totalBytes > BYTE_CAP) return collected;
      collected.push({ path: childRel, content });
      if (collected.length >= FILE_CAP) break;
    }
  }
  return collected;
}

const ensureAssetsInstalled = async (): Promise<void> => {
  try {
    const probe = await fetch("/core/busytex/busytex_pipeline.js", {
      method: "HEAD",
    });
    if (!probe.ok) throw new Error(`status ${probe.status}`);
  } catch (e) {
    throw new Error(
      "busytex assets not found at /core/busytex. Run " +
        "`npx texlyre-busytex download-assets ./public/core` once, then " +
        "restart the dev server. Original error: " +
        String(e),
    );
  }
};

export async function compileWithBusytex(
  project: Project,
): Promise<CompileResult> {
  const started = performance.now();

  let input: string;
  try {
    input = await ipc.readProjectTextFile(project.rootPath, project.rootFile);
  } catch (e) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: `failed to read ${project.rootFile}: ${String(e)}`,
          file: project.rootFile,
          line: 1,
        },
      ],
      log: String(e),
      durationMs: Math.round(performance.now() - started),
    };
  }

  try {
    await ensureAssetsInstalled();
  } catch (e) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: String(e instanceof Error ? e.message : e),
          file: project.rootFile,
          line: 1,
        },
      ],
      log: String(e instanceof Error ? e.message : e),
      durationMs: Math.round(performance.now() - started),
    };
  }

  // Pick up sibling .tex/.bib/.cls/.sty files so multi-file projects compile.
  // Best-effort: failures while reading the tree fall back to single-file mode.
  let additionalFiles: AdditionalFile[] = [];
  try {
    additionalFiles = await collectProjectFiles(
      project.rootPath,
      project.rootFile,
    );
  } catch {
    additionalFiles = [];
  }

  // If we found any .bib siblings, flip bibtex on so cited entries resolve.
  const hasBibliography = additionalFiles.some((f) =>
    f.path.toLowerCase().endsWith(".bib"),
  );

  let result;
  try {
    const tool = await getPdfLatex();
    result = await tool.compile({
      input,
      mainTexPath: project.rootFile,
      additionalFiles,
      bibtex: hasBibliography,
      makeindex: false,
      rerun: true,
      verbose: "info",
    });
  } catch (e) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: `busytex threw: ${String(e instanceof Error ? e.message : e)}`,
          file: project.rootFile,
          line: 1,
        },
      ],
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
        diagnostics: [
          {
            severity: "error",
            message: `compile succeeded but writing the PDF to disk failed: ${String(e)}`,
            file: project.rootFile,
            line: 1,
          },
        ],
        log: result.log,
        durationMs: Math.round(performance.now() - started),
      };
    }

    // Persist the SyncTeX blob alongside the PDF so the synctex CLI can
    // resolve forward/inverse against busytex output. Magic-byte sniff
    // picks the extension; the CLI handles both. Errors are best-effort
    // — losing SyncTeX shouldn't fail the build.
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
      } catch {
        // Soft fail — log will still surface to the user.
      }
    }
  }

  // Reuse the Rust LaTeX log parser so diagnostics share the same shape
  // and prefix-handling as the desktop engines.
  let diagnostics: CompileResult["diagnostics"] = [];
  try {
    const parsed = await ipc.parseLatexLog(result.log, project.rootFile);
    diagnostics = parsed.map((d) => ({
      severity: d.severity,
      message: d.message,
      file: d.file,
      line: d.line,
    }));
  } catch {
    // Parser is best-effort; the raw log is still surfaced.
  }

  return {
    ok: result.success,
    outputPath,
    diagnostics,
    log: result.log,
    durationMs: Math.round(performance.now() - started),
  };
}

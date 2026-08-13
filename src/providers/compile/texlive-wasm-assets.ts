import type { EngineConfig, EngineHandle, EngineId, VfsBackend } from "@typeward/texlive-wasm";

/**
 * Engine artifacts (glue `.js` + `.wasm`) are served from the app's OWN origin:
 * Vite copies `public/` verbatim into `dist/`, and `tauri build` ships `dist/`
 * as the webview root. The engine worker `import()`s the glue and `fetch()`es
 * the wasm by URL, and only the app origin satisfies the CSP (`script-src
 * 'self'`) — the Tauri resource dir is not URL-addressable without enabling the
 * asset protocol.
 */
const ENGINE_BASE_URL = "/texlive-wasm";

/** The TeX Live tree, by contrast, is read lazily off disk through TauriFS
 * (`bundle.resources`) rather than the webview origin — it is far too large to
 * ship through the bundle graph. Bundled resources land under
 * `<resource>/resources/...` (per `bundle.resources`), while a dev-tree download
 * (`npx texlive-wasm download-assets ... ./src-tauri/resources/texlive-wasm`)
 * resolves as `texlive-wasm/...` — so probe both candidates, the same tolerant
 * pattern templates.rs uses for the built-in templates. */
const TEXMF_CANDIDATES = ["texlive-wasm/texmf", "resources/texlive-wasm/texmf"];
let texmfRootPromise: Promise<string | null> | null = null;

/** The first TDS candidate that actually exists under the resource dir, or null
 * if the tree wasn't bundled. Cached — the assets ship with the app. */
async function resolveTexmfRoot(): Promise<string | null> {
  if (!texmfRootPromise) {
    texmfRootPromise = (async () => {
      const { exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      for (const root of TEXMF_CANDIDATES) {
        try {
          if (await exists(root, { baseDir: BaseDirectory.Resource })) return root;
        } catch {
          // try the next candidate
        }
      }
      return null;
    })();
  }
  return texmfRootPromise;
}

/** Engines the mobile compile path can use. `pdflatex` is required; the rest
 * are only needed by documents that cite, index, or use biblatex. */
export type WasmEngine = Extract<
  EngineId,
  "pdflatex" | "bibtexu" | "makeindex" | "biber"
>;

const REQUIRED_ENGINE: WasmEngine = "pdflatex";
const HELPER_ENGINES: WasmEngine[] = ["bibtexu", "makeindex", "biber"];

const enginePathFor = (id: WasmEngine) => `${ENGINE_BASE_URL}/${id}/emscripten/${id}.wasm`;
const engineGlueFor = (id: WasmEngine) => `${ENGINE_BASE_URL}/${id}/emscripten/${id}.js`;

export interface AssetStatus {
  /** A plain document can compile: the pdflatex engine AND the TeX tree exist. */
  ok: boolean;
  /** Per-engine presence — both the glue JS and the wasm, not just the wasm. */
  engines: Record<WasmEngine, boolean>;
  /** The TDS tree under the Tauri resource dir. */
  texmf: boolean;
  /** Human-readable names of what's missing, required or not. */
  missing: string[];
  /** Actionable unavailable-state for the UI. Empty when `ok`. */
  message: string;
}

export const DOWNLOAD_HINT =
  "Run `npx texlive-wasm download-assets --assets pdflatex-emscripten,bibtexu-emscripten,makeindex-emscripten ./public/texlive-wasm` " +
  "and `npx texlive-wasm download-assets --assets texmf-core-pdflatex ./src-tauri/resources/texlive-wasm`, then rebuild the app.";

/** A HEAD that some custom-protocol handlers don't implement; fall back to a
 * one-byte ranged GET rather than downloading a multi-megabyte engine. */
async function urlExists(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) return true;
    if (head.status !== 405 && head.status !== 501) return false;
  } catch {
    /* fall through to the ranged GET */
  }
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    return res.ok;
  } catch {
    return false;
  }
}

async function engineAvailable(id: WasmEngine): Promise<boolean> {
  const [wasm, glue] = await Promise.all([
    urlExists(enginePathFor(id)),
    urlExists(engineGlueFor(id)),
  ]);
  return wasm && glue;
}

async function texmfAvailable(): Promise<boolean> {
  try {
    const root = await resolveTexmfRoot();
    if (!root) return false;
    const { readDir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(root, { baseDir: BaseDirectory.Resource });
    return entries.some((e) => e.isDirectory && e.name === "tex");
  } catch {
    return false;
  }
}

let statusPromise: Promise<AssetStatus> | null = null;

/** Probe every asset a compile actually needs. Cached — the assets ship with
 * the app and cannot appear at runtime. */
export function texliveWasmAssetStatus(): Promise<AssetStatus> {
  if (!statusPromise) {
    statusPromise = probe().catch((e) => {
      statusPromise = null;
      throw e;
    });
  }
  return statusPromise;
}

export function resetAssetStatusForTests(): void {
  statusPromise = null;
  enginesPromise = null;
}

async function probe(): Promise<AssetStatus> {
  const ids: WasmEngine[] = [REQUIRED_ENGINE, ...HELPER_ENGINES];
  const [present, texmf] = await Promise.all([
    Promise.all(ids.map(engineAvailable)),
    texmfAvailable(),
  ]);

  const engines = Object.fromEntries(
    ids.map((id, i) => [id, present[i]]),
  ) as Record<WasmEngine, boolean>;

  const missing: string[] = [];
  if (!engines[REQUIRED_ENGINE]) missing.push("the pdflatex engine (glue + wasm)");
  if (!texmf) missing.push("the TeX Live tree (texmf)");
  for (const id of HELPER_ENGINES) {
    if (!engines[id]) missing.push(`the ${id} engine`);
  }

  const ok = engines[REQUIRED_ENGINE] && texmf;
  const message = missing.length === 0
    ? ""
    : `texlive-wasm assets not found: ${missing.join(", ")}. ${DOWNLOAD_HINT}`;

  return { ok, engines, texmf, missing, message };
}

/** The unavailable-state a UI surface can render: null when compiling works. */
export async function texliveWasmUnavailableReason(): Promise<string | null> {
  const status = await texliveWasmAssetStatus();
  return status.ok ? null : status.message;
}

export interface EngineBundle {
  tex: EngineHandle;
  /** Config for the helper engines latexmk builds on demand — each is a
   * separate wasm artifact and needs its own `enginePath` plus the same TDS. */
  engineConfig: (id: EngineId) => EngineConfig;
}

let enginesPromise: Promise<EngineBundle> | null = null;

export function getEngineBundle(): Promise<EngineBundle> {
  if (enginesPromise) return enginesPromise;
  const p = (async () => {
    const { createEngine } = await import("@typeward/texlive-wasm");
    const { createTauriFs } = await import("@typeward/texlive-wasm/tauri");
    const { BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const texmfRoot = (await resolveTexmfRoot()) ?? TEXMF_CANDIDATES[0];
    const vfs: VfsBackend[] = [
      await createTauriFs({ texmfRoot, baseDir: BaseDirectory.Resource }),
    ];
    const engineConfig = (id: EngineId): EngineConfig => ({
      enginePath: enginePathFor(id as WasmEngine),
      vfs,
    });
    const tex = await createEngine(REQUIRED_ENGINE, engineConfig(REQUIRED_ENGINE));
    return { tex, engineConfig };
  })();
  enginesPromise = p;
  p.catch(() => {
    if (enginesPromise === p) enginesPromise = null;
  });
  return p;
}

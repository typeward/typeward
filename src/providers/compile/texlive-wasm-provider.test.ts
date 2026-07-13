import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readProjectTextFile: vi.fn(),
  readProjectBinaryFile: vi.fn(),
  writeProjectBinaryFile: vi.fn(),
  parseLatexLog: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  createEngine: vi.fn(),
  latexmk: vi.fn(),
  willRunBibtex: vi.fn(),
  willRunBiber: vi.fn(),
  createTauriFs: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("~/ipc", () => ({
  readProjectTextFile: mocks.readProjectTextFile,
  readProjectBinaryFile: mocks.readProjectBinaryFile,
  writeProjectBinaryFile: mocks.writeProjectBinaryFile,
  parseLatexLog: mocks.parseLatexLog,
}));

vi.mock("~/stores/editor-store", () => ({
  activeFile: vi.fn(() => null),
  project: vi.fn(() => null),
}));

vi.mock("texlive-wasm/worker?url", () => ({
  default: "/assets/texlive-wasm-worker.js",
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: mocks.readDir,
  exists: mocks.exists,
  BaseDirectory: { Resource: 11 },
}));

vi.mock("texlive-wasm", () => ({
  createEngine: mocks.createEngine,
  latexmk: mocks.latexmk,
  willRunBibtex: mocks.willRunBibtex,
  willRunBiber: mocks.willRunBiber,
}));

vi.mock("texlive-wasm/tauri", () => ({
  createTauriFs: mocks.createTauriFs,
}));

const PROJECT = {
  name: "demo",
  rootPath: "/tmp/demo",
  rootFile: "main.tex",
  format: "latex",
} as const;

/** Engine glue+wasm live on the app origin; the TDS lives in the resource dir.
 * `present` lists the engines whose URLs resolve. */
function serveAssets(present: string[]) {
  mocks.fetch.mockImplementation(async (url: string) => {
    const engine = /\/texlive-wasm\/([^/]+)\//.exec(String(url))?.[1];
    const ok = !!engine && present.includes(engine);
    return { ok, status: ok ? 200 : 404 };
  });
}

describe("texlive-wasm-provider", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.readProjectTextFile.mockReset().mockResolvedValue(
      "\\documentclass{article}\\begin{document}Hi\\end{document}",
    );
    mocks.readProjectBinaryFile.mockReset().mockResolvedValue(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    mocks.writeProjectBinaryFile.mockReset().mockResolvedValue(undefined);
    mocks.parseLatexLog.mockReset().mockResolvedValue([]);
    // Resource-dir reads are the TDS probe (texmf holds a `tex` tree); reads
    // without a baseDir are the project walker, which sees an empty project.
    mocks.readDir
      .mockReset()
      .mockImplementation(async (_path: string, opts?: { baseDir?: number }) =>
        opts?.baseDir ? [{ name: "tex", isDirectory: true }] : [],
      );
    mocks.exists.mockReset().mockResolvedValue(true);
    mocks.createEngine.mockReset().mockResolvedValue({ id: "pdflatex" });
    mocks.createTauriFs.mockReset().mockResolvedValue({ id: "taurifs" });
    mocks.willRunBibtex.mockReset().mockReturnValue(false);
    mocks.willRunBiber.mockReset().mockReturnValue(false);
    mocks.fetch.mockReset();
    serveAssets(["pdflatex", "bibtexu", "makeindex", "biber"]);
    mocks.latexmk.mockReset().mockResolvedValue({
      success: true,
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      log: "",
      logs: [],
      exitCode: 0,
    });
  });

  it("reports every missing asset class, not just the wasm", async () => {
    serveAssets([]);
    mocks.exists.mockResolvedValue(false);

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm(PROJECT);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    const msg = result.diagnostics[0]?.message ?? "";
    expect(msg).toMatch(/texlive-wasm assets not found/);
    expect(msg).toMatch(/pdflatex engine/);
    expect(msg).toMatch(/TeX Live tree/);
    expect(msg).toMatch(/npx texlive-wasm download-assets/);
    expect(result.diagnostics[0]?.file).toBe("main.tex");
  });

  it("is unavailable when the engine wasm is there but the glue JS is not", async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      const ok = String(url).endsWith(".wasm");
      return { ok, status: ok ? 200 : 404 };
    });

    const { texliveWasmUnavailableReason } = await import("./texlive-wasm-assets");
    expect(await texliveWasmUnavailableReason()).toMatch(/pdflatex engine \(glue \+ wasm\)/);
  });

  it("is unavailable when the TDS is present but empty", async () => {
    mocks.readDir.mockImplementation(async () => []);

    const { texliveWasmUnavailableReason } = await import("./texlive-wasm-assets");
    expect(await texliveWasmUnavailableReason()).toMatch(/TeX Live tree/);
  });

  it("passes a real enginePath for the tex engine and the helper engines", async () => {
    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    await compileWithTexliveWasm(PROJECT);

    expect(mocks.createEngine).toHaveBeenCalledWith(
      "pdflatex",
      expect.objectContaining({
        enginePath: "/texlive-wasm/pdflatex/emscripten/pdflatex.wasm",
        vfs: [{ id: "taurifs" }],
      }),
    );

    const call = mocks.latexmk.mock.calls[0][0];
    expect(call.handles.tex).toEqual({ id: "pdflatex" });
    expect(call.engineConfig("bibtexu")).toEqual({
      enginePath: "/texlive-wasm/bibtexu/emscripten/bibtexu.wasm",
      vfs: [{ id: "taurifs" }],
    });
  });

  it("refuses to compile a document whose helper engine is not bundled", async () => {
    serveAssets(["pdflatex"]);
    mocks.willRunBibtex.mockReturnValue(true);

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm(PROJECT);

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toMatch(/needs the bibtexu engine/);
    expect(mocks.latexmk).not.toHaveBeenCalled();
  });

  it("skips helper passes whose engine is absent when the document doesn't need it", async () => {
    serveAssets(["pdflatex"]);

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm(PROJECT);

    expect(result.ok).toBe(true);
    const call = mocks.latexmk.mock.calls[0][0];
    expect(call.bibtex).toBe(false);
    expect(call.biber).toBe(false);
    expect(call.makeindex).toBe(false);
  });

  it("returns a structured error when the root file cannot be read", async () => {
    mocks.readProjectTextFile.mockRejectedValue(new Error("ENOENT"));

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm({ ...PROJECT, rootFile: "missing.tex" });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toMatch(/failed to read missing\.tex/);
  });

  it("returns a structured error when latexmk throws", async () => {
    mocks.latexmk.mockRejectedValue(new Error("WASM OOM"));

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm(PROJECT);

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toMatch(/texlive-wasm threw.*WASM OOM/);
  });
});

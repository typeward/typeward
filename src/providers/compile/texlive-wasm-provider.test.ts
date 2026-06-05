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
  withTauriFs: vi.fn(),
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
}));

vi.mock("texlive-wasm/tauri", () => ({
  withTauriFs: mocks.withTauriFs,
}));

describe("texlive-wasm-provider", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readProjectTextFile.mockReset().mockResolvedValue(
      "\\documentclass{article}\\begin{document}Hi\\end{document}",
    );
    mocks.readProjectBinaryFile.mockReset().mockResolvedValue(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    mocks.writeProjectBinaryFile.mockReset().mockResolvedValue(undefined);
    mocks.parseLatexLog.mockReset().mockResolvedValue([]);
    mocks.readDir.mockReset().mockResolvedValue([]);
    mocks.exists.mockReset().mockResolvedValue(false);
    mocks.createEngine.mockReset().mockResolvedValue({});
    mocks.latexmk.mockReset().mockResolvedValue({
      success: true,
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      log: "",
      logs: [],
      exitCode: 0,
    });
    mocks.withTauriFs
      .mockReset()
      .mockImplementation(async (factory: (vfs: unknown[]) => Promise<unknown>) =>
        factory([]),
      );
  });

  it("returns an actionable error when assets are missing", async () => {
    const { exists } = await import("@tauri-apps/plugin-fs");
    (exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm({
      name: "demo",
      rootPath: "/tmp/demo",
      rootFile: "main.tex",
      format: "latex",
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(/texlive-wasm assets not found/);
    expect(result.diagnostics[0]?.message).toMatch(/npx texlive-wasm download-assets/);
    expect(result.diagnostics[0]?.file).toBe("main.tex");
  });

  it("returns a structured error when the root file cannot be read", async () => {
    const ipcMod = await import("~/ipc");
    (ipcMod.readProjectTextFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ENOENT"),
    );

    const { exists } = await import("@tauri-apps/plugin-fs");
    (exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm({
      name: "demo",
      rootPath: "/tmp/demo",
      rootFile: "missing.tex",
      format: "latex",
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toMatch(/failed to read missing\.tex/);
  });

  it("returns a structured error when latexmk throws", async () => {
    const ipcMod = await import("~/ipc");
    (ipcMod.readProjectTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "\\documentclass{article}\\begin{document}Hi\\end{document}",
    );

    const { exists } = await import("@tauri-apps/plugin-fs");
    (exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const texlive = await import("texlive-wasm");
    (texlive.latexmk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WASM OOM"),
    );

    const { compileWithTexliveWasm } = await import("./texlive-wasm-provider");
    const result = await compileWithTexliveWasm({
      name: "demo",
      rootPath: "/tmp/demo",
      rootFile: "main.tex",
      format: "latex",
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toMatch(/texlive-wasm threw.*WASM OOM/);
  });
});

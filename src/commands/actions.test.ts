import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompileResult, Project } from "~/adapters/types";

// actions.ts is the cross-subsystem funnel (save -> cloud push -> compile ->
// telemetry). We drive the REAL editor-store (so markFileCleanIfUnchanged /
// setFileBaseHash / activeFile behave as they ship) and mock only the leaf
// side-effect modules: IPC, toast (Kobalte), hash, cloud push queue, the
// conflict-path helper, telemetry, the format adapters, and settings.
const h = vi.hoisted(() => ({
  writeProjectTextFile: vi.fn(),
  readProjectTextFile: vi.fn(),
  historyRecord: vi.fn(),
  synctexForward: vi.fn(),
  synctexInverse: vi.fn(),
  notifyError: vi.fn(),
  notifyLocalSave: vi.fn(),
  recordError: vi.fn(),
  suffixWithConflict: vi.fn(),
  sha256Hex: vi.fn(),
  latexCompile: vi.fn(),
  typstCompile: vi.fn(),
  autoCompile: false,
  compileEngineValue: "system-tex" as string,
}));

vi.mock("~/ipc", () => ({
  writeProjectTextFile: h.writeProjectTextFile,
  readProjectTextFile: h.readProjectTextFile,
  historyRecord: h.historyRecord,
  synctexForward: h.synctexForward,
  synctexInverse: h.synctexInverse,
}));
vi.mock("~/lib/toast", () => ({ notifyError: h.notifyError }));
vi.mock("~/lib/hash", () => ({ sha256Hex: h.sha256Hex }));
vi.mock("~/integrations/cloud/init", () => ({ notifyLocalSave: h.notifyLocalSave }));
vi.mock("~/integrations/cloud/core", () => ({ suffixWithConflict: h.suffixWithConflict }));
vi.mock("~/lib/telemetry", () => ({ recordError: h.recordError }));
vi.mock("~/adapters/latex/LatexAdapter", () => ({
  LatexAdapter: { languageId: "latex", format: "latex", compile: h.latexCompile, commands: [] },
}));
vi.mock("~/adapters/typst/TypstAdapter", () => ({
  TypstAdapter: { languageId: "typst", format: "typst", compile: h.typstCompile, commands: [] },
}));
vi.mock("~/stores/settings-store", () => ({
  editorSettings: () => ({ autoCompile: h.autoCompile }),
  compileEngine: () => h.compileEngineValue,
}));

import {
  compileActiveProject,
  pathRelativeToProjectRoot,
  saveActiveFile,
} from "./actions";
import {
  activeFile,
  compileState,
  lastResult,
  openFile,
  resetCompileState,
  resetTabs,
  setProject,
  type OpenFile,
} from "~/stores/editor-store";

const projectA: Project = {
  rootPath: "/A",
  rootFile: "main.tex",
  format: "latex",
  name: "A",
};

const okResult = (outputPath = "/A/out.pdf"): CompileResult => ({
  ok: true,
  outputPath,
  diagnostics: [],
  log: "",
  durationMs: 1,
});

const openBuffer = (over: Partial<OpenFile>): void => {
  openFile({
    path: "/A/main.tex",
    relPath: "main.tex",
    content: "buffer content",
    dirty: true,
    ...over,
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  // Deterministic content-addressed hashes so conflict comparisons are exact.
  h.sha256Hex.mockImplementation((s: string) => Promise.resolve("h:" + s));
  h.suffixWithConflict.mockImplementation((rel: string) =>
    rel.replace(/(\.[^.]+)$/, ".conflict$1"),
  );
  h.readProjectTextFile.mockResolvedValue("");
  h.writeProjectTextFile.mockResolvedValue(undefined);
  h.historyRecord.mockResolvedValue(true);
  h.notifyLocalSave.mockReturnValue(undefined);
  h.latexCompile.mockResolvedValue(okResult());
  h.autoCompile = false;
  h.compileEngineValue = "system-tex";
  resetTabs();
  setProject(null);
  resetCompileState();
});

describe("pathRelativeToProjectRoot", () => {
  it("does not treat sibling paths with a shared prefix as project children", () => {
    expect(pathRelativeToProjectRoot("/home/me/project", "/home/me/project-copy/main.tex"))
      .toBeNull();
  });

  it("returns a relative path for files under the project root", () => {
    expect(pathRelativeToProjectRoot("/home/me/project", "/home/me/project/sections/a.tex"))
      .toBe("sections/a.tex");
  });
});

describe("saveActiveFile", () => {
  it("writes the buffer, then enqueues the cloud push with exactly the saved relPath", async () => {
    setProject(projectA);
    openBuffer({ content: "hello", dirty: true }); // no baseHash -> conflict guard skipped

    await saveActiveFile();

    expect(h.writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(h.writeProjectTextFile).toHaveBeenCalledWith("/A", "main.tex", "hello");
    // No origin hash means preserveConflictingDiskCopy never reads disk.
    expect(h.readProjectTextFile).not.toHaveBeenCalled();

    expect(h.notifyLocalSave).toHaveBeenCalledTimes(1);
    expect(h.notifyLocalSave).toHaveBeenCalledWith("/A", ["main.tex"]);

    // The write must complete before the push is queued (the sync contract).
    expect(h.writeProjectTextFile.mock.invocationCallOrder[0]).toBeLessThan(
      h.notifyLocalSave.mock.invocationCallOrder[0],
    );

    // Buffer marked clean and its base hash advanced to what hit disk.
    expect(activeFile()?.dirty).toBe(false);
    expect(activeFile()?.baseHash).toBe("h:hello");
  });

  it("does nothing when there is no active file", async () => {
    setProject(projectA);
    await saveActiveFile();
    expect(h.writeProjectTextFile).not.toHaveBeenCalled();
    expect(h.notifyLocalSave).not.toHaveBeenCalled();
  });
});

describe("history snapshot hook", () => {
  it("fires a history record for the saved file after the write lands", async () => {
    setProject(projectA);
    openBuffer({ content: "hello", dirty: true });

    await saveActiveFile();

    expect(h.historyRecord).toHaveBeenCalledTimes(1);
    expect(h.historyRecord).toHaveBeenCalledWith("/A", "main.tex");
    // History observes saves, it never precedes them.
    expect(h.writeProjectTextFile.mock.invocationCallOrder[0]).toBeLessThan(
      h.historyRecord.mock.invocationCallOrder[0],
    );
  });

  it("never blocks or fails the save when the history IPC rejects", async () => {
    setProject(projectA);
    openBuffer({ content: "hello", dirty: true });
    h.historyRecord.mockRejectedValue(new Error("history store offline"));

    await expect(saveActiveFile()).resolves.toBeUndefined();

    // The save completed normally — buffer clean, cloud push queued.
    expect(activeFile()?.dirty).toBe(false);
    expect(h.notifyLocalSave).toHaveBeenCalledWith("/A", ["main.tex"]);
    // The failure lands in telemetry only (fire-and-forget catch).
    await vi.waitFor(() => {
      expect(h.recordError).toHaveBeenCalledWith(
        "history-record",
        expect.stringContaining("main.tex"),
        expect.any(Error),
      );
    });
  });

  it("even a synchronous throw from the history wrapper cannot break the save", async () => {
    setProject(projectA);
    openBuffer({ content: "hello", dirty: true });
    h.historyRecord.mockImplementation(() => {
      throw new Error("sync explosion");
    });

    await expect(saveActiveFile()).resolves.toBeUndefined();
    expect(activeFile()?.dirty).toBe(false);
    expect(h.recordError).toHaveBeenCalledWith(
      "history-record",
      expect.stringContaining("main.tex"),
      expect.any(Error),
    );
  });
});

describe("save-after-pull conflict guard", () => {
  it("preserves a .conflict sidecar when disk changed under the buffer", async () => {
    setProject(projectA);
    openBuffer({ content: "buffer content", baseHash: "h:base", dirty: true });
    // Disk holds a newer collaborator edit whose hash differs from the base.
    h.readProjectTextFile.mockResolvedValue("disk changed");

    await saveActiveFile();

    expect(h.readProjectTextFile).toHaveBeenCalledWith("/A", "main.tex");
    expect(h.suffixWithConflict).toHaveBeenCalledWith("main.tex", expect.any(Number));

    // Sidecar (disk copy) written first, then the buffer over the canonical path.
    expect(h.writeProjectTextFile).toHaveBeenCalledTimes(2);
    expect(h.writeProjectTextFile.mock.calls[0]).toEqual([
      "/A",
      "main.conflict.tex",
      "disk changed",
    ]);
    expect(h.writeProjectTextFile.mock.calls[1]).toEqual([
      "/A",
      "main.tex",
      "buffer content",
    ]);
    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(h.notifyLocalSave).toHaveBeenCalledWith("/A", ["main.tex"]);
  });

  it("does NOT preserve a sidecar when the disk still matches the base hash", async () => {
    setProject(projectA);
    // Buffer diverged locally, but disk is untouched since load (hash == base).
    openBuffer({ content: "edited buffer", baseHash: "h:disk original", dirty: true });
    h.readProjectTextFile.mockResolvedValue("disk original");

    await saveActiveFile();

    expect(h.readProjectTextFile).toHaveBeenCalledTimes(1);
    expect(h.suffixWithConflict).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();
    // Only the canonical write happens.
    expect(h.writeProjectTextFile).toHaveBeenCalledTimes(1);
    expect(h.writeProjectTextFile).toHaveBeenCalledWith("/A", "main.tex", "edited buffer");
  });
});

describe("compileActiveProject", () => {
  it("drops a stale result when the active project changed mid-compile", async () => {
    setProject(projectA);
    const projectB: Project = { ...projectA, rootPath: "/B", name: "B" };
    // The adapter await resolves only after the user has switched to project B.
    h.latexCompile.mockImplementation(async () => {
      setProject(projectB);
      return okResult("/A/out.pdf");
    });

    await compileActiveProject();

    // Result belonged to A but A is no longer active -> discarded, not painted.
    expect(lastResult()).toBeNull();
    expect(compileState()).toBe("compiling");
  });

  it("applies the result when the project is still current", async () => {
    setProject(projectA);
    h.latexCompile.mockResolvedValue(okResult("/A/out.pdf"));

    await compileActiveProject();

    expect(lastResult()?.outputPath).toBe("/A/out.pdf");
    expect(compileState()).toBe("ok");
  });

  it("is a no-op while a compile is already in flight (guards dueling latexmk runs)", async () => {
    setProject(projectA);
    let resolveFirst!: (r: CompileResult) => void;
    h.latexCompile.mockImplementationOnce(
      () => new Promise<CompileResult>((r) => (resolveFirst = r)),
    );

    const first = compileActiveProject(); // enters "compiling", awaits adapter
    await compileActiveProject(); // second call must bail on the guard

    expect(h.latexCompile).toHaveBeenCalledTimes(1);

    resolveFirst(okResult("/A/out.pdf"));
    await first;
    expect(compileState()).toBe("ok");
  });

  it("routes a save failure into the Issues tab instead of throwing", async () => {
    setProject(projectA);
    openBuffer({ content: "dirty", baseHash: undefined, dirty: true });
    h.writeProjectTextFile.mockRejectedValue(new Error("disk full"));

    await expect(compileActiveProject()).resolves.toBeUndefined();

    expect(h.latexCompile).not.toHaveBeenCalled();
    expect(compileState()).toBe("error");
    expect(lastResult()?.ok).toBe(false);
    expect(lastResult()?.diagnostics[0]?.message).toContain("disk full");
  });
});

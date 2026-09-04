import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "~/adapters/types";

// Drive the REAL editor-store; mock only the leaf side effects. `autosaveDelayMs`
// is 0 so the debounce fires on the next macrotask, and `autosaveEnabled` reads
// a mutable flag so one installed effect can exercise both branches.
const h = vi.hoisted(() => ({
  saveOpenFile: vi.fn(),
  writeSnapshot: vi.fn(),
  clearSnapshot: vi.fn(),
  notifyError: vi.fn(),
  recordError: vi.fn(),
  enabled: true,
}));

vi.mock("~/commands/actions", () => ({ saveOpenFile: h.saveOpenFile }));
vi.mock("~/ipc", () => ({ writeSnapshot: h.writeSnapshot, clearSnapshot: h.clearSnapshot }));
vi.mock("~/lib/toast", () => ({ notifyError: h.notifyError }));
vi.mock("~/lib/telemetry", () => ({ recordError: h.recordError }));
vi.mock("~/stores/settings-store", () => ({
  editorSettings: () => ({ autosaveEnabled: h.enabled, autosaveDelayMs: 0 }),
}));

import { setupAutosave } from "./index";
import {
  openFile,
  renameOpenFile,
  resetTabs,
  setActiveIndex,
  setProject,
  updateActiveFile,
} from "~/stores/editor-store";

const projectA: Project = { rootPath: "/A", rootFile: "main.tex", format: "latex", name: "A" };

// Let the reactive effect run, the 0ms debounce fire, and its async persist settle.
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5));
};

beforeAll(() => {
  setupAutosave();
});

beforeEach(async () => {
  // Drain any pending timer / switch-away flush from the prior test's dirty
  // file BEFORE resetting the spies, so its noise isn't attributed here.
  setProject(projectA);
  resetTabs();
  await flush();
  h.saveOpenFile.mockReset().mockResolvedValue(undefined);
  h.writeSnapshot.mockReset().mockResolvedValue(undefined);
  h.clearSnapshot.mockReset().mockResolvedValue(undefined);
  h.notifyError.mockReset();
  h.recordError.mockReset();
});

describe("autosave branch on autosaveEnabled", () => {
  it("performs a real save via saveOpenFile when enabled", async () => {
    h.enabled = true;

    openFile({ path: "/A/on.tex", relPath: "on.tex", content: "typed", dirty: true });
    await flush();

    expect(h.saveOpenFile).toHaveBeenCalledTimes(1);
    const [proj, file] = h.saveOpenFile.mock.calls[0];
    expect(proj.rootPath).toBe("/A");
    expect(file.relPath).toBe("on.tex");
    expect(h.writeSnapshot).not.toHaveBeenCalled();
  });

  it("writes only a crash-recovery snapshot when disabled", async () => {
    h.enabled = false;

    openFile({ path: "/A/off.tex", relPath: "off.tex", content: "typed", dirty: true });
    await flush();

    expect(h.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(h.writeSnapshot).toHaveBeenCalledWith("/A", "off.tex", "typed");
    expect(h.saveOpenFile).not.toHaveBeenCalled();
  });
});

describe("captured state is revalidated before it is written", () => {
  // A rename repoints the dirty tab's path while keeping it dirty, which the
  // effect sees as a tab switch. Flushing the captured (old) path recreated the
  // file the user had just renamed away — leaving two divergent copies, and on
  // a cloud project pushing the ghost to the remote.
  it("does not resurrect the old path when a dirty file is renamed mid-debounce", async () => {
    h.enabled = true;

    openFile({
      path: "/A/chapter.tex",
      relPath: "chapter.tex",
      content: "typed",
      dirty: true,
    });
    renameOpenFile("chapter.tex", "chapter2.tex", "/A/chapter2.tex");
    await flush();

    const written = h.saveOpenFile.mock.calls.map(([, f]) => f.relPath);
    expect(written).not.toContain("chapter.tex");
  });

  // The effect body is async; a run that suspends on a flush can resume after a
  // newer run armed its timer. The stale run must not write the bytes it
  // captured — that reverts the file and mints a conflict sidecar from the
  // user's own newer content.
  it("does not write content the buffer has already moved past", async () => {
    h.enabled = true;

    openFile({ path: "/A/live.tex", relPath: "live.tex", content: "v1", dirty: true });
    setActiveIndex(0);
    updateActiveFile({ content: "v2" });
    await flush();

    const contents = h.saveOpenFile.mock.calls.map(([, f]) => f.content);
    expect(contents).not.toContain("v1");
    expect(contents).toContain("v2");
  });

  // The revalidation must stay narrow: switching away from a still-open dirty
  // file is the case the flush exists for, and it must keep working.
  it("still flushes the previous file when switching tabs mid-debounce", async () => {
    h.enabled = true;

    openFile({ path: "/A/first.tex", relPath: "first.tex", content: "edited", dirty: true });
    openFile({ path: "/A/second.tex", relPath: "second.tex", content: "other", dirty: true });
    await flush();

    const written = h.saveOpenFile.mock.calls.map(([, f]) => f.relPath);
    expect(written).toContain("first.tex");
  });
});

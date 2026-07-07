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
import { openFile, resetTabs, setProject } from "~/stores/editor-store";

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

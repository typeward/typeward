import { render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "~/adapters/types";

// The panel is the list/diff/restore orchestrator; mock the leaves — IPC
// (typed ipcMock so an unstubbed wrapper fails loudly), the save funnel, the
// hash helper, toast, telemetry, and the lazily-mounted CM diff — and drive
// the REAL editor-store so adoptDiskContent behaves as it ships.
const spies = vi.hoisted(() => ({
  historyListProject: vi.fn(),
  readProjectTextFile: vi.fn(),
  historyReadVersion: vi.fn(),
  historyRestore: vi.fn(),
  historyClear: vi.fn(),
  saveOpenFile: vi.fn(),
  sha256Hex: vi.fn(),
  mountHistoryDiff: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyLocalSave: vi.fn(),
  recordError: vi.fn(),
}));

vi.mock("~/ipc", async () => {
  const { ipcMock } = await import("~/test/ipc-mock");
  return ipcMock({
    historyListProject: spies.historyListProject,
    readProjectTextFile: spies.readProjectTextFile,
    historyReadVersion: spies.historyReadVersion,
    historyRestore: spies.historyRestore,
    historyClear: spies.historyClear,
  });
});
vi.mock("~/commands/actions", () => ({ saveOpenFile: spies.saveOpenFile }));
vi.mock("~/lib/hash", () => ({ sha256Hex: spies.sha256Hex }));
vi.mock("./history-diff", () => ({ mountHistoryDiff: spies.mountHistoryDiff }));
vi.mock("~/lib/toast", () => ({
  notifySuccess: spies.notifySuccess,
  notifyError: spies.notifyError,
}));
vi.mock("~/lib/telemetry", () => ({ recordError: spies.recordError }));
vi.mock("~/integrations/cloud/init", () => ({
  notifyLocalSave: spies.notifyLocalSave,
}));

import { HistoryPanel } from "./HistoryPanel";
import {
  activeFile,
  openFile,
  resetTabs,
  setProject,
} from "~/stores/editor-store";

const projectA: Project = {
  rootPath: "/A",
  rootFile: "main.tex",
  format: "latex",
  name: "A",
};

// Two recorded versions, newest first (the Rust list order), project-wide.
const V_NEW = {
  relPath: "main.tex",
  hash: "a".repeat(64),
  ts: Date.now() - 2 * 60_000,
  size: 2048,
};
const V_OLD = {
  relPath: "chapters/intro.tex",
  hash: "b".repeat(64),
  ts: Date.now() - 2 * 3_600_000,
  size: 100,
};

beforeEach(() => {
  vi.resetAllMocks();
  spies.historyListProject.mockResolvedValue([V_NEW, V_OLD]);
  spies.readProjectTextFile.mockResolvedValue("disk content");
  spies.historyReadVersion.mockResolvedValue("old content");
  spies.historyRestore.mockResolvedValue("old content");
  spies.mountHistoryDiff.mockResolvedValue(() => {});
  spies.saveOpenFile.mockResolvedValue(undefined);
  spies.sha256Hex.mockImplementation((s: string) => Promise.resolve("h:" + s));
  resetTabs();
  setProject(projectA);
  openFile({
    path: "/A/main.tex",
    relPath: "main.tex",
    content: "current buffer",
    dirty: false,
    baseHash: "h:current buffer",
  });
});

const restoreButton = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Restore this version"),
  ) as HTMLButtonElement | undefined;

describe("HistoryPanel", () => {
  it("lists every file's versions project-wide with path, time, and size", async () => {
    const { findByText, container } = render(() => <HistoryPanel />);

    await findByText(/2m ago/);
    await findByText(/2h ago/);
    expect(spies.historyListProject).toHaveBeenCalledWith("/A");

    const text = container.textContent ?? "";
    expect(text).toContain("main.tex");
    expect(text).toContain("chapters/intro.tex");
    expect(text).toContain("2.0 KB");
    expect(text).toContain("100 B");
  });

  it("selecting a version opens a read-only diff against the current buffer", async () => {
    const { findByText } = render(() => <HistoryPanel />);

    (await findByText(/2m ago/)).click();

    await waitFor(() => {
      expect(spies.historyReadVersion).toHaveBeenCalledWith("/A", "main.tex", V_NEW.hash);
      expect(spies.mountHistoryDiff).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        "old content",
        "current buffer",
      );
    });
    // Kobalte portals the dialog into document.body.
    expect(document.body.textContent).toContain("Restore this version");
  });

  it("diffs a version of a file that has no open tab against its disk content", async () => {
    const { findByText } = render(() => <HistoryPanel />);

    (await findByText(/2h ago/)).click();

    await waitFor(() => {
      expect(spies.historyReadVersion).toHaveBeenCalledWith(
        "/A",
        "chapters/intro.tex",
        V_OLD.hash,
      );
      expect(spies.readProjectTextFile).toHaveBeenCalledWith("/A", "chapters/intro.tex");
      expect(spies.mountHistoryDiff).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        "old content",
        "disk content",
      );
    });
  });

  it("restore saves a dirty buffer first, then adopts the restored content clean", async () => {
    resetTabs();
    openFile({
      path: "/A/main.tex",
      relPath: "main.tex",
      content: "current buffer",
      dirty: true,
      baseHash: "h:disk",
    });
    const { findByText } = render(() => <HistoryPanel />);

    (await findByText(/2m ago/)).click();
    const btn = await waitFor(() => {
      const b = restoreButton();
      expect(b).toBeTruthy();
      expect(b!.disabled).toBe(false);
      return b!;
    });
    btn.click();

    await waitFor(() => {
      expect(spies.historyRestore).toHaveBeenCalledWith("/A", "main.tex", V_NEW.hash);
    });
    // Dirty buffer flushed to disk BEFORE the restore overwrote it, so the
    // Rust force-record captured exactly that state.
    expect(spies.saveOpenFile).toHaveBeenCalledTimes(1);
    expect(spies.saveOpenFile.mock.invocationCallOrder[0]).toBeLessThan(
      spies.historyRestore.mock.invocationCallOrder[0],
    );
    // Buffer adopted the restored content: clean + recomputed base hash so the
    // save conflict guard doesn't misfire on the next save.
    await waitFor(() => {
      expect(activeFile()?.content).toBe("old content");
      expect(activeFile()?.dirty).toBe(false);
      expect(activeFile()?.baseHash).toBe("h:old content");
    });
    // The adopt generation bumped — text-shell folds it into the editor key,
    // so the mounted CodeMirror remounts on the restored content instead of
    // keeping the pre-restore doc (which autosave would write back to disk).
    expect(activeFile()?.adoptGeneration).toBe(1);
    // The restored content pushes to cloud sync like any save — after the
    // disk write completed (the sync contract).
    expect(spies.notifyLocalSave).toHaveBeenCalledWith("/A", ["main.tex"]);
    expect(spies.historyRestore.mock.invocationCallOrder[0]).toBeLessThan(
      spies.notifyLocalSave.mock.invocationCallOrder[0],
    );
    expect(spies.notifySuccess).toHaveBeenCalled();
    // The list refetches so the just-captured pre-restore version shows up.
    expect(spies.historyListProject.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not save first when the buffer is already clean", async () => {
    const { findByText } = render(() => <HistoryPanel />);

    (await findByText(/2m ago/)).click();
    const btn = await waitFor(() => {
      const b = restoreButton();
      expect(b).toBeTruthy();
      expect(b!.disabled).toBe(false);
      return b!;
    });
    btn.click();

    await waitFor(() => {
      expect(spies.historyRestore).toHaveBeenCalledTimes(1);
    });
    expect(spies.saveOpenFile).not.toHaveBeenCalled();
  });

  it("surfaces a restore failure as a toast + telemetry and keeps the buffer", async () => {
    spies.historyRestore.mockRejectedValue(new Error("blob missing"));
    const { findByText } = render(() => <HistoryPanel />);

    (await findByText(/2m ago/)).click();
    const btn = await waitFor(() => {
      const b = restoreButton();
      expect(b).toBeTruthy();
      expect(b!.disabled).toBe(false);
      return b!;
    });
    btn.click();

    await waitFor(() => {
      expect(spies.notifyError).toHaveBeenCalled();
      expect(spies.recordError).toHaveBeenCalledWith(
        "history-restore",
        expect.stringContaining("main.tex"),
        expect.any(Error),
      );
    });
    expect(activeFile()?.content).toBe("current buffer");
    // Nothing landed on disk, so nothing may be queued for push.
    expect(spies.notifyLocalSave).not.toHaveBeenCalled();
  });

  it("shows the empty state for a project with no history", async () => {
    spies.historyListProject.mockResolvedValue([]);
    const { findByText } = render(() => <HistoryPanel />);
    await findByText(/No versions yet/);
  });
});

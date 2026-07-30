import { describe, it, expect, beforeEach } from "vitest";
import {
  openFile,
  openFiles,
  restoreFileContent,
  resetTabs,
  type OpenFile,
} from "./editor-store";

function mk(over: Partial<OpenFile> = {}): OpenFile {
  return {
    path: "/proj/main.tex",
    relPath: "main.tex",
    content: "old",
    dirty: false,
    ...over,
  };
}

describe("editor-store restoreFileContent (crash recovery, TW-S1-02)", () => {
  beforeEach(() => resetTabs());

  it("bumps adoptGeneration when restoring different content into an open tab", () => {
    // The root file is typically already open when RecoveryDialog restores it.
    openFile(mk({ content: "on-disk", adoptGeneration: 0 }));
    restoreFileContent(mk({ content: "recovered" }));

    const f = openFiles()[0];
    expect(f.content).toBe("recovered");
    expect(f.dirty).toBe(true);
    // Bumped so the keyed editor remounts on the recovered content instead of
    // keeping the stale on-disk buffer captured at mount.
    expect(f.adoptGeneration).toBe(1);
  });

  it("does not bump adoptGeneration when the restored content is identical", () => {
    openFile(mk({ content: "same", adoptGeneration: 3 }));
    restoreFileContent(mk({ content: "same" }));
    expect(openFiles()[0].adoptGeneration).toBe(3);
  });

  it("opens a new tab (dirty) when the recovered file is not already open", () => {
    restoreFileContent(
      mk({ path: "/proj/other.tex", relPath: "other.tex", content: "x" }),
    );
    const f = openFiles().find((o) => o.relPath === "other.tex");
    expect(f?.dirty).toBe(true);
    expect(f?.content).toBe("x");
  });
});

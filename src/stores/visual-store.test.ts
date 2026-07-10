import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "~/adapters/types";

const spies = vi.hoisted(() => ({
  recordError: vi.fn(),
  notifyInfo: vi.fn(),
}));

vi.mock("~/lib/telemetry", () => ({ recordError: spies.recordError }));
vi.mock("~/lib/toast", () => ({ notifyInfo: spies.notifyInfo }));

import { setProject } from "~/stores/editor-store";
import {
  _resetVisualPausedForTests,
  markVisualPaused,
  visualPaused,
} from "./visual-store";

const projectA: Project = {
  rootPath: "/A",
  rootFile: "main.tex",
  format: "latex",
  name: "A",
};
const projectB: Project = {
  rootPath: "/B",
  rootFile: "main.tex",
  format: "latex",
  name: "B",
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetVisualPausedForTests();
  setProject(projectA);
});

describe("visual-store pause scoping", () => {
  it("pauses the file in the project it was marked in", () => {
    expect(visualPaused("main.tex")).toBe(false);
    markVisualPaused("main.tex");
    expect(visualPaused("main.tex")).toBe(true);
  });

  it("does not bleed a pause onto a same-named file in another project", () => {
    markVisualPaused("main.tex");

    setProject(projectB);
    expect(visualPaused("main.tex")).toBe(false);
  });

  it("keeps the pause when switching back to the original project", () => {
    markVisualPaused("main.tex");
    setProject(projectB);
    setProject(projectA);

    expect(visualPaused("main.tex")).toBe(true);
  });

  it("tracks pauses per project independently", () => {
    markVisualPaused("main.tex");
    setProject(projectB);
    markVisualPaused("chapter.tex");

    expect(visualPaused("chapter.tex")).toBe(true);
    expect(visualPaused("main.tex")).toBe(false);
    setProject(projectA);
    expect(visualPaused("main.tex")).toBe(true);
    expect(visualPaused("chapter.tex")).toBe(false);
  });

  it("toasts once per session, records telemetry per pause", () => {
    markVisualPaused("main.tex");
    setProject(projectB);
    markVisualPaused("main.tex");

    expect(spies.notifyInfo).toHaveBeenCalledTimes(1);
    expect(spies.recordError).toHaveBeenCalledTimes(2);
  });
});

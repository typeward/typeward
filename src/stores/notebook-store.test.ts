import { beforeEach, describe, expect, it } from "vitest";
import { _resetIdsForTests } from "~/lib/notebook/parser";
import {
  activeCellId,
  cells,
  setActiveCellId,
} from "./notebook-store";
import {
  openFile,
  resetTabs,
  setProject,
} from "./editor-store";

const flushEffects = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("notebook-store", () => {
  beforeEach(() => {
    _resetIdsForTests();
    resetTabs();
    setProject({
      name: "Notebook",
      rootPath: "C:\\project",
      rootFile: "one.Rmd",
      format: "rmarkdown",
      experience: "notebook",
    });
    setActiveCellId(null);
  });

  it("resets the active cell to the first parsed cell when switching notebook files", async () => {
    openFile({
      path: "C:\\project\\one.Rmd",
      relPath: "one.Rmd",
      content: "Intro\n\n```{r}\nx <- 1\n```\n",
      dirty: false,
    });
    await flushEffects();

    expect(cells().map((cell) => cell.kind)).toEqual(["markdown", "code"]);
    setActiveCellId(cells()[1]!.id);

    openFile({
      path: "C:\\project\\two.Rmd",
      relPath: "two.Rmd",
      content: "Second notebook\n",
      dirty: false,
    });
    await flushEffects();

    expect(cells()).toHaveLength(1);
    expect(cells()[0]!.content).toBe("Second notebook");
    expect(activeCellId()).toBe(cells()[0]!.id);
  });
});

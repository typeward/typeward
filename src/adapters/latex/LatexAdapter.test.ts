import { describe, expect, it } from "vitest";
import { LatexAdapter } from "./LatexAdapter";

describe("LatexAdapter", () => {
  it("publishes a Mod+J forward-search command", () => {
    const sync = LatexAdapter.commands.find((c) => c.id === "latex.syncForward");
    expect(sync).toBeDefined();
    expect(sync?.shortcut).toBe("Mod+J");
    expect(sync?.scope).toBe("editor");
    expect(sync?.group).toBe("Navigation");
  });

  it("registers the compile, forward-search, and chapter-draft commands", () => {
    const ids = LatexAdapter.commands.map((c) => c.id).sort();
    expect(ids).toEqual(["latex.compile", "latex.draftChapter", "latex.syncForward"]);
  });

  it("publishes a chapter-draft command in the Build group", () => {
    const draft = LatexAdapter.commands.find((c) => c.id === "latex.draftChapter");
    expect(draft).toBeDefined();
    expect(draft?.group).toBe("Build");
    expect(draft?.scope).toBe("editor");
  });
});

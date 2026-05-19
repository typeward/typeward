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

  it("has compile + syncForward as its registered commands", () => {
    const ids = LatexAdapter.commands.map((c) => c.id).sort();
    expect(ids).toEqual(["latex.compile", "latex.syncForward"]);
  });
});

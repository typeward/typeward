import { describe, expect, it } from "vitest";
import type { DocumentExperience } from "~/experiences/types";
import type { ProjectFormat } from "~/adapters/types";
import { LatexAdapter } from "./latex/LatexAdapter";
import { TypstAdapter } from "./typst/TypstAdapter";

// Adapter shape contract. Every concrete adapter must:
//   1. Declare a `format` matching a ProjectFormat union member.
//   2. Declare an `experience` ("text" for all current adapters).
//   3. Publish a build command with Mod+Enter in the Build group, scoped
//      to "editor" — the global keyboard router uses these conventions
//      to route the shortcut correctly.

interface AdapterCase {
  name: string;
  adapter: { format: ProjectFormat; experience: DocumentExperience; commands: any[] };
  buildCommandId: string;
}

const adapters: AdapterCase[] = [
  { name: "LatexAdapter", adapter: LatexAdapter, buildCommandId: "latex.compile" },
  { name: "TypstAdapter", adapter: TypstAdapter, buildCommandId: "typst.compile" },
];

describe.each(adapters)("$name", ({ adapter, buildCommandId }) => {
  it("publishes a build command with Mod+Enter, editor scope, Build group", () => {
    const build = adapter.commands.find((c) => c.id === buildCommandId);
    expect(build, `must publish ${buildCommandId}`).toBeDefined();
    expect(build?.shortcut).toBe("Mod+Enter");
    expect(build?.group).toBe("Build");
    expect(build?.scope).toBe("editor");
  });
});

describe("experience routing", () => {
  it("text-experience adapters: latex, typst", () => {
    for (const a of [LatexAdapter, TypstAdapter]) {
      expect(a.experience).toBe("text");
    }
  });
});

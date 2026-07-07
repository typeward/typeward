import { describe, it, expect } from "vitest";
import { parseOutline } from "./parse";

describe("parseOutline — latex", () => {
  it("parses sections, starred forms, and nests by level", () => {
    const tex = [
      "\\section{Intro}",
      "text",
      "\\subsection{Background}",
      "\\section*{Methods}",
      "\\subsubsection{Detail}",
    ].join("\n");
    const out = parseOutline(tex, "latex");
    expect(out.map((s) => s.title)).toEqual(["Intro", "Methods"]);
    expect(out[0].children.map((c) => c.title)).toEqual(["Background"]);
    expect(out[1].children[0].title).toBe("Detail");
    expect(out[0].line).toBe(1);
  });

  it("captures balanced braces and skips multi-line titles", () => {
    const tex = "\\section{A \\textbf{bold} title}\n\\section{unterminated";
    const out = parseOutline(tex, "latex");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("A \\textbf{bold} title");
  });

  it("ignores sections in % comments; respects the \\% escape", () => {
    const tex = [
      "% \\section{Commented out}",
      "\\section{Real} % \\subsection{trailing comment ignored}",
      // The \% is an escaped literal percent, so \section after it is real.
      "text \\% \\section{After an escaped percent}",
    ].join("\n");
    const out = parseOutline(tex, "latex");
    expect(out.map((s) => s.title)).toEqual(["Real", "After an escaped percent"]);
    expect(out[0].children).toHaveLength(0);
  });
});

describe("parseOutline — typst", () => {
  it("uses = depth for heading level", () => {
    const typ = "= One\n== Two\n=== Three\n= Four";
    const out = parseOutline(typ, "typst");
    expect(out.map((s) => s.title)).toEqual(["One", "Four"]);
    expect(out[0].children[0].title).toBe("Two");
    expect(out[0].children[0].children[0].title).toBe("Three");
  });
});

describe("parseOutline — markdown", () => {
  it("skips fenced code blocks", () => {
    const md = ["# Title", "```", "# not a heading", "```", "## Real"].join("\n");
    const out = parseOutline(md, "markdown");
    expect(out.map((s) => s.title)).toEqual(["Title"]);
    expect(out[0].children.map((c) => c.title)).toEqual(["Real"]);
  });
});

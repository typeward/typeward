import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { openFile, resetTabs, setProject } from "~/stores/editor-store";
import { setActiveEditorView } from "~/stores/editor-view-store";
import {
  applyFormat,
  formattingLanguageForPath,
  supportsFormat,
} from "./format-actions";

// project() and activeFile() are null in tests unless a case sets them, so
// applyFormat resolves the LaTeX snippet set by default.

let view: EditorView | null = null;

const makeView = (
  doc: string,
  selection?: { anchor: number; head?: number },
): EditorView => {
  view = new EditorView({ doc, parent: document.body });
  if (selection) view.dispatch({ selection });
  setActiveEditorView(view);
  return view;
};

const setActiveFile = (relPath: string): void => {
  openFile({ path: `C:/proj/${relPath}`, relPath, content: "", dirty: false });
};

afterEach(() => {
  setActiveEditorView(null);
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
  resetTabs();
  setProject(null);
});

describe("applyFormat: caret insert", () => {
  it("inserts the empty construct with the cursor at the marker", () => {
    const v = makeView("hello ", { anchor: 6 });
    applyFormat("bold");
    expect(v.state.doc.toString()).toBe("hello \\textbf{}");
    expect(v.state.selection.main.head).toBe(6 + "\\textbf{".length);
  });
});

describe("applyFormat: selection wrap", () => {
  it("wraps the selection in the inline style and keeps it selected", () => {
    const v = makeView("hello world", { anchor: 6, head: 11 });
    applyFormat("bold");
    expect(v.state.doc.toString()).toBe("hello \\textbf{world}");
    const sel = v.state.selection.main;
    expect(v.state.sliceDoc(sel.from, sel.to)).toBe("world");
  });

  it("compounds styles on the kept selection", () => {
    const v = makeView("x word y", { anchor: 2, head: 6 });
    applyFormat("bold");
    applyFormat("italic");
    expect(v.state.doc.toString()).toBe("x \\textbf{\\textit{word}} y");
  });

  it("wraps a selection into an underline", () => {
    const v = makeView("a b c", { anchor: 2, head: 3 });
    applyFormat("underline");
    expect(v.state.doc.toString()).toBe("a \\underline{b} c");
  });

  it("turns a selected line into a heading", () => {
    const v = makeView("Introduction", { anchor: 0, head: 12 });
    applyFormat("heading");
    expect(v.state.doc.toString()).toBe("\\section{Introduction}\n");
  });
});

describe("applyFormat: list conversion", () => {
  it("turns selected lines into itemize items", () => {
    const v = makeView("one\ntwo\nthree", { anchor: 0, head: 13 });
    applyFormat("list");
    expect(v.state.doc.toString()).toBe(
      "\\begin{itemize}\n  \\item one\n  \\item two\n  \\item three\n\\end{itemize}\n",
    );
  });

  it("numbers selected lines as enumerate items and skips blanks", () => {
    const v = makeView("one\n\ntwo", { anchor: 0, head: 8 });
    applyFormat("orderedList");
    expect(v.state.doc.toString()).toBe(
      "\\begin{enumerate}\n  \\item one\n  \\item two\n\\end{enumerate}\n",
    );
  });
});

describe("applyFormat: non-wrapping kinds", () => {
  it("citation inserts at the caret even with a selection", () => {
    const v = makeView("hello world", { anchor: 0, head: 5 });
    applyFormat("citation");
    // The selection's content is not a citation key — the construct lands
    // at the head with the cursor in the key slot; nothing is deleted.
    expect(v.state.doc.toString()).toContain("\\cite{}");
    expect(v.state.doc.toString()).toContain("hello world".slice(0, 5));
  });
});

describe("formattingLanguageForPath", () => {
  it("maps prose sources to their dialect", () => {
    expect(formattingLanguageForPath("main.tex")).toBe("latex");
    expect(formattingLanguageForPath("style.sty")).toBe("latex");
    expect(formattingLanguageForPath("thesis.cls")).toBe("latex");
    expect(formattingLanguageForPath("paper.typ")).toBe("typst");
    expect(formattingLanguageForPath("README.md")).toBe("markdown");
    expect(formattingLanguageForPath("notes.MARKDOWN")).toBe("markdown");
  });

  it("returns null for non-prose files — .bib highlights as latex but takes no formatting", () => {
    expect(formattingLanguageForPath("refs.bib")).toBeNull();
    expect(formattingLanguageForPath("figure.png")).toBeNull();
    expect(formattingLanguageForPath("Makefile")).toBeNull();
  });
});

describe("applyFormat: dialect follows the active file, not the project", () => {
  const latexProject = {
    rootPath: "C:/proj",
    rootFile: "main.tex",
    format: "latex" as const,
    name: "proj",
  };

  it("writes markdown bold into a .md file inside a latex project", () => {
    setProject(latexProject);
    setActiveFile("README.md");
    const v = makeView("hello world", { anchor: 6, head: 11 });
    applyFormat("bold");
    expect(v.state.doc.toString()).toBe("hello **world**");
  });

  it("no-ops on a .bib file even in a latex project", () => {
    setProject(latexProject);
    setActiveFile("refs.bib");
    const v = makeView("@article{key}", { anchor: 0, head: 8 });
    applyFormat("bold");
    expect(v.state.doc.toString()).toBe("@article{key}");
  });

  it("converts selected .md lines into markdown list items", () => {
    setActiveFile("notes.md");
    const v = makeView("one\ntwo", { anchor: 0, head: 7 });
    applyFormat("orderedList");
    expect(v.state.doc.toString()).toBe("1. one\n2. two\n");
  });
});

describe("per-language capability", () => {
  it("markdown has no underline; latex and typst do", () => {
    expect(supportsFormat("markdown", "underline")).toBe(false);
    expect(supportsFormat("markdown", "bold")).toBe(true);
    expect(supportsFormat("latex", "underline")).toBe(true);
    expect(supportsFormat("typst", "underline")).toBe(true);
  });

  it("underline no-ops in a markdown file", () => {
    setActiveFile("README.md");
    const v = makeView("a word b", { anchor: 2, head: 6 });
    applyFormat("underline");
    expect(v.state.doc.toString()).toBe("a word b");
  });
});

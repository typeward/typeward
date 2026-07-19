import { afterEach, describe, expect, it } from "vitest";
import { history, undo, undoDepth } from "@codemirror/commands";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { guardCommandsForTests as cmd } from "./edit-guards";
import { visualExtension } from "./cm6";

function makeView(doc: string, cfg = {}): EditorView {
  // history() mirrors the host component (undo coherence is part of the
  // contract under test).
  return new EditorView({
    doc,
    extensions: [history(), visualExtension(cfg)],
    parent: document.body,
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

const ARTICLE = [
  "\\documentclass[12pt]{article}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "\\section{Intro}",
  "Hello \\textbf{bold} world with \\cite{knuth84}.",
  "",
  "\\begin{itemize}",
  "\\item First",
  "\\item Second",
  "\\end{itemize}",
  "\\end{document}",
  "",
].join("\n");

describe("visual cm6: never-reveal", () => {
  it("renders no markup anywhere in the content DOM", () => {
    const view = makeView(ARTICLE);
    const text = view.contentDOM.textContent ?? "";
    expect(text).not.toContain("\\section");
    expect(text).not.toContain("\\textbf");
    expect(text).not.toContain("\\begin");
    expect(text).not.toContain("\\documentclass");
    expect(text).toContain("Intro");
    expect(text).toContain("bold");
    expect(text).toContain("First");
    view.destroy();
  });

  it("keeps markup hidden when the selection enters a construct (anti-v1)", () => {
    const view = makeView(ARTICLE);
    const boldAt = ARTICLE.indexOf("bold");
    view.dispatch({ selection: { anchor: boldAt + 2 } });
    const text = view.contentDOM.textContent ?? "";
    expect(text).not.toContain("\\textbf");
    expect(text).not.toContain("{");
    view.destroy();
  });

  it("renders structural furniture: heading mark, pill chip, item markers, preamble chip", () => {
    const view = makeView(ARTICLE);
    expect(view.contentDOM.querySelector(".cm-vis-h1")?.textContent).toBe("Intro");
    expect(view.contentDOM.querySelector(".cm-vis-pill")?.textContent).toBe(
      "knuth84",
    );
    const markers = view.contentDOM.querySelectorAll(".cm-vis-marker");
    expect(markers.length).toBe(2);
    expect(
      view.contentDOM.querySelector(".cm-vis-preamble")?.textContent,
    ).toContain("article");
    view.destroy();
  });

  it("renders math environments as KaTeX blocks, not source", () => {
    const view = makeView(
      "Before\n\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n\nAfter\n",
    );
    const block = view.contentDOM.querySelector(".cm-vis-math-block");
    expect(block).not.toBeNull();
    expect(block?.querySelector(".katex")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("a &= b");
    expect(view.contentDOM.textContent).toContain("Before");
    view.destroy();
  });

  it("renders inline math via KaTeX and unknown environments as cards", () => {
    const view = makeView(
      "Euler: $e^2$ here.\n\n\\begin{mysterybox}\nopaque interior\n\\end{mysterybox}\n",
    );
    const inline = view.contentDOM.querySelector(".cm-vis-math-inline");
    expect(inline?.querySelector(".katex")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("$e^2$");
    // The card shows the env NAME as its badge; the body stays hidden.
    expect(
      view.contentDOM.querySelector(".cm-vis-card-badge")?.textContent,
    ).toBe("mysterybox");
    expect(view.contentDOM.textContent).not.toContain("opaque interior");
    view.destroy();
  });
});

describe("visual cm6: tables and figures", () => {
  it("renders a simple tabular as a formatted table", () => {
    const view = makeView(
      "Text\n\n\\begin{table}\n\\begin{tabular}{ll}\nName & Value \\\\\nAlpha & 1 \\\\\n\\end{tabular}\n\\caption{My data}\n\\end{table}\n",
    );
    const table = view.contentDOM.querySelector(".cm-vis-table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("tr").length).toBe(2);
    expect(table?.textContent).toContain("Alpha");
    expect(table?.textContent).toContain("My data");
    expect(view.contentDOM.textContent).not.toContain("\\begin");
    view.destroy();
  });

  it("renders figures as placeholder previews with captions", () => {
    const view = makeView(
      "Text\n\n\\begin{figure}\n\\includegraphics[width=0.8\\linewidth]{plots/result.png}\n\\caption{The result}\n\\end{figure}\n",
    );
    const fig = view.contentDOM.querySelector(".cm-vis-figure");
    expect(fig).not.toBeNull();
    // No resolveAsset configured → placeholder naming the file.
    expect(fig?.textContent).toContain("plots/result.png");
    expect(fig?.textContent).toContain("The result");
    expect(view.contentDOM.textContent).not.toContain("\\includegraphics");
    view.destroy();
  });
});

describe("visual cm6: zero-corruption", () => {
  it("mount, interaction, and unmount never change the document", () => {
    const compartment = new Compartment();
    const view = new EditorView({
      doc: ARTICLE,
      extensions: [compartment.of(visualExtension())],
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: ARTICLE.indexOf("bold") } });
    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ effects: compartment.reconfigure([]) });
    view.dispatch({ effects: compartment.reconfigure(visualExtension()) });
    expect(view.state.doc.toString()).toBe(ARTICLE);
    view.destroy();
  });

  it("typing inside a heading title edits only the title", () => {
    const view = makeView(ARTICLE);
    const titleAt = ARTICLE.indexOf("Intro");
    view.dispatch({
      changes: { from: titleAt, insert: "My " },
      userEvent: "input.type",
    });
    expect(view.state.doc.toString()).toContain("\\section{My Intro}");
    expect(view.contentDOM.textContent).not.toContain("\\section");
    view.destroy();
  });
});

describe("visual cm6: closure filter", () => {
  it("preserves wrapper pairs when a deletion covers only one half", () => {
    const doc = "aa \\textbf{bold} zz";
    const view = makeView(doc);
    // User deletion from before the construct into the content: the hidden
    // "\\textbf{" must survive; only visible chars go.
    view.dispatch({
      changes: { from: 0, to: doc.indexOf("ld") },
      userEvent: "delete.selection",
    });
    const out = view.state.doc.toString();
    expect(out).toBe("\\textbf{ld} zz");
    view.destroy();
  });

  it("deletes a fully-covered construct whole", () => {
    const doc = "aa \\textbf{bold} zz";
    const view = makeView(doc);
    view.dispatch({
      changes: { from: 0, to: doc.indexOf(" zz") },
      userEvent: "delete.selection",
    });
    expect(view.state.doc.toString()).toBe(" zz");
    view.destroy();
  });

  it("relocates a user insertion out of a hidden wrapper", () => {
    const doc = "aa \\textbf{bold} zz";
    const view = makeView(doc);
    const inside = doc.indexOf("\\textbf{") + 3;
    view.dispatch({
      changes: { from: inside, insert: "X" },
      userEvent: "input.type",
    });
    const out = view.state.doc.toString();
    expect(out).toContain("\\textbf{");
    expect(out).not.toContain("\\teXxtbf");
    expect(out).not.toContain("\\texXtbf");
    view.destroy();
  });

  it("snaps a programmatic selection out of hidden markup", () => {
    const doc = "aa \\textbf{bold} zz";
    const view = makeView(doc);
    const inside = doc.indexOf("\\textbf{") + 4;
    view.dispatch({ selection: { anchor: inside } });
    const head = view.state.selection.main.head;
    const open = doc.indexOf("\\textbf{");
    const contentFrom = open + "\\textbf{".length;
    expect(head === open || head === contentFrom).toBe(true);
    view.destroy();
  });
});

describe("visual cm6: keymap semantics", () => {
  it("Backspace on an empty heading deletes the whole construct", () => {
    const doc = "\\section{}\nText after\n";
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: "\\section{".length } });
    expect(cmd.backspace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Text after\n");
    view.destroy();
  });

  it("Backspace at the start of a non-empty title unwraps the heading", () => {
    const doc = "\\section{Intro}\nBody\n";
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: "\\section{".length } });
    expect(cmd.backspace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Intro\nBody\n");
    view.destroy();
  });

  it("Backspace after a widget selects it first, then deletes it", () => {
    const doc = "see \\cite{knuth84} end";
    const view = makeView(doc);
    const after = doc.indexOf("}") + 1;
    view.dispatch({ selection: { anchor: after } });
    expect(cmd.backspace(view)).toBe(true);
    const sel = view.state.selection.main;
    expect(sel.from).toBe(doc.indexOf("\\cite"));
    expect(sel.to).toBe(after);
    expect(view.state.doc.toString()).toBe(doc);
    // Second press: the selection is non-empty → default selection delete,
    // which the closure filter turns into a whole-construct removal.
    view.dispatch({
      changes: { from: sel.from, to: sel.to },
      userEvent: "delete.selection",
    });
    expect(view.state.doc.toString()).toBe("see  end");
    view.destroy();
  });

  it("Backspace merges an item into the previous one by removing the marker", () => {
    const doc = "\\begin{itemize}\n\\item First\n\\item Second\n\\end{itemize}\n";
    const view = makeView(doc);
    const secondMarker = doc.indexOf("\\item Second");
    view.dispatch({ selection: { anchor: secondMarker + "\\item ".length } });
    expect(cmd.backspace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "\\begin{itemize}\n\\item First\nSecond\n\\end{itemize}\n",
    );
    view.destroy();
  });

  it("Enter in a paragraph starts a new paragraph (blank-line separator)", () => {
    const doc = "One two\n";
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: 3 } });
    expect(cmd.enter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("One\n\n two\n");
    view.destroy();
  });

  it("Enter inside a list item splits it into a new item", () => {
    const doc = "\\begin{itemize}\n\\item First long\n\\end{itemize}\n";
    const view = makeView(doc);
    const at = doc.indexOf("First") + "First".length;
    view.dispatch({ selection: { anchor: at } });
    expect(cmd.enter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "\\begin{itemize}\n\\item First\n\\item  long\n\\end{itemize}\n",
    );
    view.destroy();
  });

  it("Enter mid-title splits the heading in two", () => {
    const doc = "\\section{One Two}\nBody\n";
    const view = makeView(doc);
    const at = doc.indexOf("One Two") + 3;
    view.dispatch({ selection: { anchor: at } });
    expect(cmd.enter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("\\section{One}\n\\section{ Two}\nBody\n");
    view.destroy();
  });

  it("Shift+Enter inserts a hard line break", () => {
    const doc = "One two\n";
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: 3 } });
    expect(cmd.shiftEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("One\\\\\n two\n");
    view.destroy();
  });

  it("Backspace at a construct's start never eats the neighbor's wrapper", () => {
    // Regression: the retarget used to raw-delete cFrom-1, taking half of an
    // adjacent construct's wrapper pair with it.
    const doc = "\\textbf{a}\\emph{b}";
    const view = makeView(doc);
    const emphContent = doc.indexOf("{b}") + 1;
    view.dispatch({ selection: { anchor: emphContent } });
    expect(cmd.backspace(view)).toBe(true);
    // Construct-aware recursion reaches the preceding bold construct and
    // deletes ITS last content char — both wrapper pairs stay balanced.
    expect(view.state.doc.toString()).toBe("\\textbf{}\\emph{b}");
    view.destroy();
  });

  it("Backspace after a construct ending in nested math selects the math", () => {
    const doc = "\\textbf{a$x$}";
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(cmd.backspace(view)).toBe(true);
    // Select-then-delete semantics for the trailing inline-math widget —
    // never a raw one-char delete inside `$x$`.
    const sel = view.state.selection.main;
    expect(view.state.doc.toString()).toBe(doc);
    expect(doc.slice(sel.from, sel.to)).toBe("$x$");
    view.destroy();
  });

  it("Enter mid-title continues typing in the SECOND heading", () => {
    const doc = "\\section{One Two}\nBody\n";
    const view = makeView(doc);
    const at = doc.indexOf("One Two") + 3;
    view.dispatch({ selection: { anchor: at } });
    expect(cmd.enter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("\\section{One}\n\\section{ Two}\nBody\n");
    const head = view.state.selection.main.head;
    expect(view.state.doc.toString().slice(head, head + 4)).toBe(" Two");
    view.destroy();
  });

  it("keeps structural deletions as single undo steps", () => {
    const doc = "\\section{}\nText\n";
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: "\\section{".length } });
    cmd.backspace(view);
    expect(view.state.doc.toString()).toBe("Text\n");
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});

describe("visual cm6: widget activation", () => {
  it("clicking a widget adjacent to another construct targets the clicked one", () => {
    // Regression: RangeSet.between also yields the atomic ENDING at the
    // click position, so `$a$$b$` used to open the popover for `$a$`.
    let intent: { from: number; to: number } | null = null;
    const doc = "see $a$$b$ end";
    const view = makeView(doc, {
      onOpenPopover: (i: { from: number; to: number }) => (intent = i),
    });
    const widgets = view.contentDOM.querySelectorAll(".cm-vis-math-inline");
    expect(widgets.length).toBe(2);
    widgets[1].dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(intent).not.toBeNull();
    expect(doc.slice(intent!.from, intent!.to)).toBe("$b$");
    view.destroy();
  });
});

describe("visual cm6: maintenance", () => {
  it("pauses oversized files instead of rendering them", async () => {
    let paused = false;
    const big = "x".repeat(25_000); // single line beyond MAX_LINE_LENGTH
    const view = makeView(big, { onPause: () => (paused = true) });
    await tick();
    expect(paused).toBe(true);
    view.destroy();
  });
});

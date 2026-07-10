import { afterEach, describe, expect, it } from "vitest";
import { history, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { foldedRanges } from "@codemirror/language";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { visualExtension } from "./cm6";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function makeView(doc: string, extensions = [visualExtension()]): EditorView {
  return new EditorView({ doc, extensions, parent: document.body });
}

function foldCount(view: EditorView): number {
  let count = 0;
  foldedRanges(view.state).between(0, view.state.doc.length, () => {
    count++;
  });
  return count;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("visual cm6: reveal-on-cursor", () => {
  const doc = "hello \\textbf{bold} world";

  it("hides wrapper tokens, reveals them when the selection enters, re-hides on leave", () => {
    const view = makeView(doc);
    // Hidden while the cursor (initially 0) is outside the construct.
    expect(view.contentDOM.textContent).not.toContain("\\textbf{");
    expect(view.contentDOM.textContent).toContain("bold");
    expect(view.contentDOM.querySelector(".cm-vis-bold")).not.toBeNull();

    // Selection inside the argument (the SyncTeX/goto path dispatches the
    // same kind of transaction) → plain source.
    view.dispatch({ selection: { anchor: doc.indexOf("bold") + 1 } });
    expect(view.contentDOM.textContent).toContain("\\textbf{");

    // Leaving the construct hides the wrappers again.
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.contentDOM.textContent).not.toContain("\\textbf{");
    view.destroy();
  });

  it("reveals on touch-inclusive boundaries", () => {
    const view = makeView(doc);
    const from = doc.indexOf("\\textbf");
    view.dispatch({ selection: { anchor: from } });
    expect(view.contentDOM.textContent).toContain("\\textbf{");
    view.destroy();
  });

  it("styles pills and comments without hiding their text", () => {
    // Leading text keeps the mount cursor (0) from touch-revealing the pill.
    const view = makeView("see \\cite{k} % note");
    expect(view.contentDOM.textContent).not.toContain("\\cite{");
    expect(view.contentDOM.querySelector(".cm-vis-pill")?.textContent).toBe("k");
    expect(view.contentDOM.querySelector(".cm-vis-comment")?.textContent).toBe(
      "% note",
    );
    view.destroy();
  });

  it("replaces \\item with a marker widget", () => {
    const view = makeView(
      "\\begin{enumerate}\n\\item one\n\\item two\n\\end{enumerate}\n",
    );
    const markers = view.contentDOM.querySelectorAll(".cm-vis-item-marker");
    expect([...markers].map((m) => m.textContent)).toEqual(["1. ", "2. "]);
    view.destroy();
  });
});

describe("visual cm6: preamble fold", () => {
  const doc = [
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "\\begin{document}",
    "Body text.",
    "\\end{document}",
    "",
  ].join("\n");

  it("folds the preamble once on mount", async () => {
    const view = makeView(doc);
    await tick();
    expect(foldCount(view)).toBe(1);
    // The chip renders in place of the folded lines.
    expect(view.contentDOM.querySelector(".cm-vis-preamble-chip")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("amsmath");
    expect(view.contentDOM.textContent).toContain("Body text.");
    view.destroy();
  });

  it("unfolds when a selection lands inside it (goto path) and stays unfolded", async () => {
    const view = makeView(doc);
    await tick();
    expect(foldCount(view)).toBe(1);
    view.dispatch({ selection: { anchor: doc.indexOf("amsmath") } });
    await tick();
    expect(foldCount(view)).toBe(0);
    expect(view.contentDOM.textContent).toContain("amsmath");
    // Later selection churn doesn't refold.
    view.dispatch({ selection: { anchor: doc.indexOf("Body") } });
    await tick();
    expect(foldCount(view)).toBe(0);
    view.destroy();
  });

  it("unfolds on chip click and stays unfolded for the mount", async () => {
    const view = makeView(doc);
    await tick();
    const chip = view.contentDOM.querySelector<HTMLElement>(
      ".cm-vis-preamble-chip",
    );
    expect(chip).not.toBeNull();
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(foldCount(view)).toBe(0);
    view.dispatch({ selection: { anchor: doc.indexOf("Body") } });
    await tick();
    expect(foldCount(view)).toBe(0);
    view.destroy();
  });

  it("gives fragment files (no \\begin{document}) no chip", async () => {
    const view = makeView("\\section{Chapter}\nText \\textbf{x}\n");
    await tick();
    expect(foldCount(view)).toBe(0);
    // Every other construct still renders (the heading at 0 is revealed by
    // the mount cursor touching it — assert on the bold span instead).
    expect(view.contentDOM.querySelector(".cm-vis-bold")).not.toBeNull();
    view.destroy();
  });
});

describe("visual cm6: compartment toggle round-trip", () => {
  it("never changes the document text and preserves cursor + undo depth", async () => {
    const comp = new Compartment();
    const base = "\\documentclass{a}\n\\begin{document}\n\\textbf{b}\n\\end{document}\n";
    const view = new EditorView({
      doc: base,
      extensions: [history(), comp.of([])],
      parent: document.body,
    });
    const insertAt = base.indexOf("\\textbf");
    view.dispatch({
      changes: { from: insertAt, insert: "typed " },
      selection: { anchor: insertAt + 6 },
    });
    const withEdit = view.state.doc.toString();
    expect(undoDepth(view.state)).toBe(1);

    // Source → Visual.
    view.dispatch({ effects: comp.reconfigure(visualExtension()) });
    await tick();
    expect(view.state.doc.toString()).toBe(withEdit);
    expect(view.state.selection.main.head).toBe(insertAt + 6);
    expect(undoDepth(view.state)).toBe(1);

    // Visual → Source.
    view.dispatch({ effects: comp.reconfigure([]) });
    await tick();
    expect(view.state.doc.toString()).toBe(withEdit);
    expect(view.state.selection.main.head).toBe(insertAt + 6);
    expect(undoDepth(view.state)).toBe(1);
    expect(redoDepth(view.state)).toBe(0);

    // The undo recorded before the toggles still applies cleanly.
    undo(view);
    expect(view.state.doc.toString()).toBe(base);
    view.destroy();
  });
});

describe("visual cm6: budget abort → visual-paused", () => {
  it("clears all layer decorations and raises onPause once", async () => {
    let pauses = 0;
    let t = 0;
    const doc = `\\textbf{bold} ${"y".repeat(4000)}`;
    const view = makeView(doc, [
      visualExtension({ now: () => (t += 100), onPause: () => pauses++ }),
    ]);
    await tick();
    expect(pauses).toBe(1);
    // Paused = pure source rendering: nothing hidden, nothing styled.
    expect(view.contentDOM.textContent).toContain("\\textbf{");
    expect(view.contentDOM.querySelector(".cm-vis-bold")).toBeNull();
    view.destroy();
  });
});

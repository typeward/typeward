import { beforeEach, describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { Component } from "solid-js";
import {
  _resetEditorMenuForTests,
  buildEditorMenuContext,
  editorMenuGroups,
  registerEditorMenuAction,
  type EditorMenuAction,
  type EditorMenuContext,
} from "./registry";

const Icon: Component<{ size?: number; class?: string }> = () => null;

const ctx = (over: Partial<EditorMenuContext> = {}): EditorMenuContext => ({
  view: {} as EditorView,
  path: "C:/projects/demo/main.tex",
  relPath: "main.tex",
  language: "latex",
  hasSelection: false,
  selectionText: "",
  from: 0,
  to: 0,
  ...over,
});

const action = (
  id: string,
  over: Partial<EditorMenuAction> = {},
): EditorMenuAction => ({
  id,
  label: id,
  icon: Icon,
  group: "clipboard",
  run: () => {},
  ...over,
});

const ids = (groups: EditorMenuAction[][]) =>
  groups.map((g) => g.map((a) => a.id));

beforeEach(() => _resetEditorMenuForTests());

describe("editor menu registry", () => {
  it("hides actions whose when() rejects the context", () => {
    registerEditorMenuAction(action("always"));
    registerEditorMenuAction(
      action("latex-only", { when: (c) => c.language === "latex" }),
    );
    registerEditorMenuAction(
      action("typst-only", { when: (c) => c.language === "typst" }),
    );

    expect(ids(editorMenuGroups(ctx()))).toEqual([["always", "latex-only"]]);
    expect(ids(editorMenuGroups(ctx({ language: "typst" })))).toEqual([
      ["always", "typst-only"],
    ]);
  });

  it("orders known groups by EDITOR_MENU_GROUP_ORDER, not registration order", () => {
    registerEditorMenuAction(action("nav", { group: "navigate" }));
    registerEditorMenuAction(action("edit", { group: "edit" }));
    registerEditorMenuAction(action("clip", { group: "clipboard" }));

    expect(ids(editorMenuGroups(ctx()))).toEqual([["clip"], ["edit"], ["nav"]]);
  });

  it("appends unknown groups after known ones, in first-registration order", () => {
    registerEditorMenuAction(action("ai-1", { group: "ai" }));
    registerEditorMenuAction(action("clip", { group: "clipboard" }));
    registerEditorMenuAction(action("zz", { group: "zz-tools" }));
    registerEditorMenuAction(action("ai-2", { group: "ai" }));

    expect(ids(editorMenuGroups(ctx()))).toEqual([
      ["clip"],
      ["ai-1", "ai-2"],
      ["zz"],
    ]);
  });

  it("sorts within a group by order, keeping registration order on ties", () => {
    registerEditorMenuAction(action("b", { order: 2 }));
    registerEditorMenuAction(action("tie-1", { order: 1 }));
    registerEditorMenuAction(action("a", { order: 0 }));
    registerEditorMenuAction(action("tie-2", { order: 1 }));

    expect(ids(editorMenuGroups(ctx()))).toEqual([
      ["a", "tie-1", "tie-2", "b"],
    ]);
  });

  it("drops groups whose actions were all filtered out (no dangling separator)", () => {
    registerEditorMenuAction(action("clip"));
    registerEditorMenuAction(
      action("nav", { group: "navigate", when: () => false }),
    );

    expect(ids(editorMenuGroups(ctx()))).toEqual([["clip"]]);
  });

  it("replaces an action re-registered under the same id in place", () => {
    registerEditorMenuAction(action("x", { label: "old" }));
    registerEditorMenuAction(action("y"));
    registerEditorMenuAction(action("x", { label: "new" }));

    const [group] = editorMenuGroups(ctx());
    expect(group.map((a) => [a.id, a.label])).toEqual([
      ["x", "new"],
      ["y", "y"],
    ]);
  });

  it("unregister removes the action, but not a later replacement", () => {
    const unregister = registerEditorMenuAction(action("x", { label: "old" }));
    registerEditorMenuAction(action("x", { label: "new" }));
    unregister();

    expect(ids(editorMenuGroups(ctx()))).toEqual([["x"]]);

    registerEditorMenuAction(action("y"))();
    expect(ids(editorMenuGroups(ctx()))).toEqual([["x"]]);
  });
});

describe("buildEditorMenuContext", () => {
  const fakeView = (from: number, to: number, doc: string) =>
    ({
      state: {
        selection: { main: { from, to } },
        doc: { sliceString: (a: number, b: number) => doc.slice(a, b) },
      },
    }) as unknown as EditorView;

  it("snapshots the selection from the document, not the DOM", () => {
    const c = buildEditorMenuContext(
      fakeView(2, 5, "abcdefgh"),
      "C:/projects/demo/ch/intro.typ",
      "ch/intro.typ",
    );
    expect(c.language).toBe("typst");
    expect(c.hasSelection).toBe(true);
    expect(c.selectionText).toBe("cde");
    expect(c.from).toBe(2);
    expect(c.to).toBe(5);
  });

  it("reports an empty selection without slicing the doc", () => {
    const c = buildEditorMenuContext(
      fakeView(4, 4, "abcdefgh"),
      "C:/projects/demo/notes.txt",
      "notes.txt",
    );
    expect(c.language).toBe("plain");
    expect(c.hasSelection).toBe(false);
    expect(c.selectionText).toBe("");
  });
});

import { selectAll, toggleComment } from "@codemirror/commands";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ClipboardPaste,
  Copy,
  History,
  ListTodo,
  MessageSquarePlus,
  ScanSearch,
  Scissors,
  SquareSlash,
  TextSelect,
} from "lucide-solid";
import { syncForwardFromCursor } from "~/commands/actions";
import { setRequestHistoryPanel } from "~/commands/palette-store";
import { getCommand } from "~/commands/registry";
import { describeIpcError } from "~/lib/errors";
import { notifyError } from "~/lib/toast";
import { lastResult, project } from "~/stores/editor-store";
import {
  registerEditorMenuAction,
  type EditorMenuContext,
} from "./registry";

/**
 * The built-in editor context-menu actions. Clipboard runs through the Tauri
 * plugin because `navigator.clipboard.readText()` is unreliable in the
 * webview (moved verbatim from the old inline menu in text-shell).
 *
 * Actions mutate via `ctx.view.state` read at run time — not the offsets
 * snapshotted into ctx at open — so a doc change between open and click can't
 * splice stale ranges. `ctx` fields feed the `when()`/`enabled()` predicates.
 */

const cut = async ({ view }: EditorMenuContext) => {
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return;
  try {
    await writeText(view.state.doc.sliceString(sel.from, sel.to));
  } catch (e) {
    notifyError("Couldn't cut", describeIpcError(e));
    return;
  }
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: "" },
    selection: { anchor: sel.from },
  });
  view.focus();
};

const copy = async ({ view }: EditorMenuContext) => {
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return;
  try {
    await writeText(view.state.doc.sliceString(sel.from, sel.to));
  } catch (e) {
    notifyError("Couldn't copy", describeIpcError(e));
  }
};

const paste = async ({ view }: EditorMenuContext) => {
  let text: string | null;
  try {
    text = await readText();
  } catch (e) {
    notifyError("Couldn't paste", describeIpcError(e));
    return;
  }
  if (!text) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
  });
  view.focus();
};

let registered = false;

/** Idempotent — the menu component calls this once at module load. */
export function registerBaseEditorMenuActions(): void {
  if (registered) return;
  registered = true;

  registerEditorMenuAction({
    id: "editor.cut",
    label: "Cut",
    icon: Scissors,
    group: "clipboard",
    order: 0,
    enabled: (ctx) => ctx.hasSelection,
    run: cut,
  });
  registerEditorMenuAction({
    id: "editor.copy",
    label: "Copy",
    icon: Copy,
    group: "clipboard",
    order: 1,
    enabled: (ctx) => ctx.hasSelection,
    run: copy,
  });
  registerEditorMenuAction({
    id: "editor.paste",
    label: "Paste",
    icon: ClipboardPaste,
    group: "clipboard",
    order: 2,
    run: paste,
  });
  registerEditorMenuAction({
    id: "editor.selectAll",
    label: "Select all",
    icon: TextSelect,
    group: "clipboard",
    order: 3,
    run: ({ view }) => {
      selectAll(view);
      view.focus();
    },
  });

  registerEditorMenuAction({
    id: "editor.toggleComment",
    label: "Toggle comment",
    icon: SquareSlash,
    group: "edit",
    // CM's toggleComment reads `commentTokens` language data (stex declares
    // `%`, our typst parser `//`) — gate on its presence so the item never
    // shows where the command would no-op (plain text).
    when: (ctx) =>
      ctx.view.state.languageDataAt(
        "commentTokens",
        ctx.view.state.selection.main.from,
      ).length > 0,
    run: ({ view }) => {
      toggleComment(view);
      view.focus();
    },
  });

  registerEditorMenuAction({
    id: "editor.addComment",
    label: "Add comment",
    icon: MessageSquarePlus,
    group: "review",
    order: 0,
    enabled: (ctx) => ctx.hasSelection,
    run: () => void getCommand("review.addComment")?.run(),
  });
  registerEditorMenuAction({
    id: "editor.addTodo",
    label: "Add TODO",
    icon: ListTodo,
    group: "review",
    order: 1,
    enabled: (ctx) => ctx.hasSelection,
    run: () => void getCommand("review.addTodo")?.run(),
  });

  registerEditorMenuAction({
    id: "editor.fileHistory",
    label: "Project history",
    icon: History,
    group: "navigate",
    order: 0,
    run: () => {
      setRequestHistoryPanel(true);
    },
  });
  registerEditorMenuAction({
    id: "editor.revealInPdf",
    label: "Reveal in PDF",
    icon: ScanSearch,
    group: "navigate",
    order: 1,
    // Forward search needs SyncTeX data, so: a LaTeX project, a LaTeX source
    // file, and a compiled PDF to point into.
    when: (ctx) =>
      ctx.language === "latex" &&
      project()?.format === "latex" &&
      !!lastResult()?.outputPath,
    run: () => void syncForwardFromCursor(),
  });
}

import type { EditorView } from "@codemirror/view";
import type { Component } from "solid-js";
import { languageForFile, type EditorLanguage } from "~/adapters/languages";

/**
 * Extensible action registry behind the editor's right-click menu. Base
 * actions (clipboard, comment toggle, navigation) register at startup;
 * feature modules (e.g. AI) register and unregister theirs dynamically. The
 * menu snapshots `editorMenuGroups(ctx)` each time it opens, so registration
 * timing is free — like the CommandRegistry, but scoped to the pointer menu
 * and carrying an editor context instead of a global `when()`.
 *
 * Kept as a plain module-scope Map (not a signal): the menu is transient and
 * rebuilds from scratch per open, so nothing needs to react to registration.
 */

/** Snapshot of the editor taken when the menu opens. */
export interface EditorMenuContext {
  view: EditorView;
  /** Absolute path of the active file. */
  path: string;
  relPath: string;
  language: EditorLanguage;
  hasSelection: boolean;
  /**
   * Main-selection text sliced from the document — never the DOM selection,
   * so decorations/widgets (future visual mode) can't skew it.
   */
  selectionText: string;
  from: number;
  to: number;
}

/**
 * Known groups render in this order, separated by dividers; groups not
 * listed here (feature add-ons) append after, in first-registration order.
 */
export const EDITOR_MENU_GROUP_ORDER = [
  "clipboard",
  "edit",
  "review",
  "navigate",
] as const;

export type EditorMenuGroup = (typeof EDITOR_MENU_GROUP_ORDER)[number];

export interface EditorMenuAction {
  id: string;
  label: string;
  icon: Component<{ size?: number; class?: string }>;
  group: EditorMenuGroup | (string & {});
  /** Sort key within the group (ascending; ties keep registration order). */
  order?: number;
  /** Hidden entirely when false. Omit for always-visible. */
  when?: (ctx: EditorMenuContext) => boolean;
  /** Rendered but disabled when false. Omit for always-enabled. */
  enabled?: (ctx: EditorMenuContext) => boolean;
  run: (ctx: EditorMenuContext) => void | Promise<void>;
}

interface Entry {
  action: EditorMenuAction;
  seq: number;
}

const entries = new Map<string, Entry>();
let nextSeq = 0;

/**
 * Registers (or replaces, keeping the original registration position) an
 * action. Returns an unregister fn that is a no-op once the id has been
 * re-registered by someone else.
 */
export function registerEditorMenuAction(
  action: EditorMenuAction,
): () => void {
  const entry: Entry = {
    action,
    seq: entries.get(action.id)?.seq ?? nextSeq++,
  };
  entries.set(action.id, entry);
  return () => {
    if (entries.get(action.id) === entry) entries.delete(action.id);
  };
}

/**
 * The menu's render model: visible actions bucketed by group, groups in
 * `EDITOR_MENU_GROUP_ORDER` (unknown groups appended), actions sorted by
 * `order` within each group. Groups whose actions all failed `when()` are
 * dropped so no separator dangles.
 */
export function editorMenuGroups(
  ctx: EditorMenuContext,
): EditorMenuAction[][] {
  const visible = [...entries.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.action)
    .filter((a) => a.when?.(ctx) ?? true);

  const buckets = new Map<string, EditorMenuAction[]>();
  for (const action of visible) {
    const list = buckets.get(action.group);
    if (list) list.push(action);
    else buckets.set(action.group, [action]);
  }

  const known: readonly string[] = EDITOR_MENU_GROUP_ORDER;
  const names = [
    ...known.filter((g) => buckets.has(g)),
    ...[...buckets.keys()].filter((g) => !known.includes(g)),
  ];
  return names.map((name) =>
    buckets.get(name)!.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  );
}

/** Snapshot the editor state the moment the menu opens. */
export function buildEditorMenuContext(
  view: EditorView,
  path: string,
  relPath: string,
): EditorMenuContext {
  const sel = view.state.selection.main;
  return {
    view,
    path,
    relPath,
    language: languageForFile(relPath),
    hasSelection: sel.from !== sel.to,
    selectionText:
      sel.from === sel.to ? "" : view.state.doc.sliceString(sel.from, sel.to),
    from: sel.from,
    to: sel.to,
  };
}

/** Test-only: wipe the registry. */
export function _resetEditorMenuForTests(): void {
  entries.clear();
  nextSeq = 0;
}

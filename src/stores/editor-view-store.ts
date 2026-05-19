import { EditorView } from "@codemirror/view";
import { createSignal } from "solid-js";

/**
 * Imperative handle for the currently-mounted CodeMirror EditorView.
 *
 * Held in module scope (not a Solid signal) because:
 *   - The view reference itself doesn't need reactivity — consumers care
 *     about the state inside it, which CM owns.
 *   - Actions that need to read cursor position / dispatch selection
 *     changes fire from outside Solid's reactive context (keyboard router,
 *     palette callbacks), and module-level access is the simplest way to
 *     stay decoupled from component refs.
 *
 * The `<CodeMirror>` component pushes the view in on mount and clears on
 * unmount; text-shell remounts CM on file switch so this naturally tracks
 * the active file's editor.
 */
let _view: EditorView | null = null;

/**
 * Reactive cursor position signals. CodeMirror pushes updates into these
 * via `pushCursor` from its updateListener; status bars + other surfaces
 * subscribe through Solid. 1-based for both line and column to match the
 * editor's own display + SyncTeX conventions.
 */
const [cursorLine, setCursorLineSignal] = createSignal<number | null>(null);
const [cursorCol, setCursorColSignal] = createSignal<number | null>(null);

export const setActiveEditorView = (v: EditorView | null): void => {
  _view = v;
  if (!v) {
    setCursorLineSignal(null);
    setCursorColSignal(null);
  }
};

export const getActiveEditorView = (): EditorView | null => _view;

/** Called from the CodeMirror updateListener. */
export const pushCursor = (line: number, col: number): void => {
  setCursorLineSignal(line);
  setCursorColSignal(col);
};

export { cursorCol, cursorLine };

/** Returns the 1-based line of the primary cursor, or null if no view. */
export const currentCursorLine = (): number | null => {
  if (!_view) return null;
  const pos = _view.state.selection.main.head;
  return _view.state.doc.lineAt(pos).number;
};

/**
 * Move the cursor to the given 1-based line and scroll it into view.
 * Clamps to the document's line range so synctex output that points past
 * the end of file doesn't throw.
 */
export const setCursorLine = (line: number): void => {
  if (!_view) return;
  const total = _view.state.doc.lines;
  const clamped = Math.max(1, Math.min(total, line));
  const pos = _view.state.doc.line(clamped).from;
  _view.dispatch({
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
  });
};

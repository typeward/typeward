import type { EditorView } from "@codemirror/view";
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

/**
 * Selection + scroll stash across the keyed CodeMirror remount. The editor
 * key folds LSP session readiness and grammar state into the file path, so an
 * LSP handshake landing 1-2s after a file opens remounts the editor — CM6
 * state (including undo history) is rebuilt by design there, which is an
 * acceptable loss; silently teleporting the cursor and scroll back to the top
 * is not. The shell stamps the outgoing file via `noteActiveEditorFile`;
 * `setActiveEditorView(null)` (called by CodeMirror's cleanup while the view
 * is still alive, before destroy) records the position; the next mount
 * restores it only when it shows the SAME file — a genuine tab switch lands
 * on a different path and starts fresh. Every unmount overwrites the stash,
 * so a stale position can never outlive a newer one for the same file.
 */
interface StashedEditorPosition {
  path: string;
  anchor: number;
  head: number;
  scrollTop: number;
}
let _activeEditorPath: string | null = null;
let _positionStash: StashedEditorPosition | null = null;

/** Called from the shell's keyed editor branch when a file (re)mounts. */
export const noteActiveEditorFile = (path: string): void => {
  _activeEditorPath = path;
};

/**
 * Re-apply a stashed position after a same-file remount. Selection offsets
 * are clamped to the (possibly replaced) document; the scroll restore goes
 * through requestMeasure so it lands after CM6's initial layout pass instead
 * of being clobbered by it.
 */
export const restoreEditorPosition = (view: EditorView, path: string): void => {
  const stash = _positionStash;
  if (!stash || stash.path !== path) return;
  _positionStash = null;
  const len = view.state.doc.length;
  const anchor = Math.min(stash.anchor, len);
  const head = Math.min(stash.head, len);
  view.dispatch({ selection: { anchor, head } });
  view.requestMeasure({
    read: () => null,
    write: () => {
      view.scrollDOM.scrollTop = stash.scrollTop;
    },
  });
};

export const setActiveEditorView = (v: EditorView | null): void => {
  if (!v && _view && _activeEditorPath) {
    const sel = _view.state.selection.main;
    _positionStash = {
      path: _activeEditorPath,
      anchor: sel.anchor,
      head: sel.head,
      scrollTop: _view.scrollDOM.scrollTop,
    };
  }
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

/**
 * Select the range `[from, to)` (0-based document offsets), scroll it into
 * view, and focus the editor. Offsets are clamped to the document; a
 * degenerate or inverted range collapses to a caret at `from`.
 */
export const setSelectionRange = (from: number, to: number): void => {
  if (!_view) return;
  const len = _view.state.doc.length;
  const a = Math.max(0, Math.min(len, from));
  const b = Math.max(0, Math.min(len, to));
  _view.focus();
  _view.dispatch(
    a < b
      ? { selection: { anchor: a, head: b }, scrollIntoView: true }
      : { selection: { anchor: a, head: a }, scrollIntoView: true },
  );
};

/**
 * Replace the document range `[from, to)` with `text`, select the inserted
 * text's end, and scroll it into view. Offsets are clamped to the document.
 * The AI action dialog's Replace goes through here after its stale-selection
 * guard verified the range still holds the snapshotted text.
 */
export const replaceRange = (from: number, to: number, text: string): void => {
  if (!_view) return;
  const len = _view.state.doc.length;
  const a = Math.max(0, Math.min(len, from));
  const b = Math.max(a, Math.min(len, to));
  _view.focus();
  _view.dispatch({
    changes: { from: a, to: b, insert: text },
    selection: { anchor: a + text.length },
    scrollIntoView: true,
  });
};

/**
 * Insert `text` at the primary cursor, replacing any active selection.
 * Focuses the editor first so the user sees the cursor land on the
 * inserted text. No-op when no view is mounted (e.g. before the editor
 * has opened any file).
 */
export const insertAtCursor = (text: string): void => {
  if (!_view) return;
  _view.focus();
  const range = _view.state.selection.main;
  _view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    scrollIntoView: true,
  });
};

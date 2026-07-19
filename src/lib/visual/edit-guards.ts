/**
 * Editing guards for the visual mode. Two layers:
 *
 * 1. A high-precedence keymap giving Backspace/Delete/Enter construct-aware
 *    semantics (unwrap empty constructs, merge items, select-then-delete
 *    widgets, paragraph-splitting Enter).
 * 2. A transactionFilter that (a) collapses multi-range selections,
 *    (b) snaps selection endpoints out of atomic ranges (SyncTeX inverse,
 *    search jumps, post-undo sweeps included), (c) rewrites user deletions
 *    to construct closure — a wrapper half is deleted only together with
 *    its whole construct — and (d) relocates insertions out of hidden
 *    spans. Transactions annotated `visualEdit` (popover Apply, our own
 *    keymap dispatches, idle reparses) pass untouched, as do IME
 *    compositions.
 *
 * Everything here dispatches real text edits through the normal transaction
 * pipeline — the zero-corruption invariant lives or dies on these rules,
 * and roundtrip.test.ts is their falsifier.
 */

import {
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type ChangeSpec,
  type Extension,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import type { AtomicMarker } from "./decorations";
import { visualConfig, visualEdit, visualField } from "./field";
import type { BlockNode, VisualDoc } from "./parse";
import { blockAt } from "./parse";

interface AtomicHit {
  from: number;
  to: number;
  value: AtomicMarker;
}

function atomicAt(state: EditorState, pos: number): AtomicHit | null {
  const st = state.field(visualField, false);
  if (!st || st.doc === null) return null;
  let hit: AtomicHit | null = null;
  st.built.atomics.between(Math.max(0, pos - 1), pos + 1, (from, to, value) => {
    if (from < pos && pos < to) {
      hit = { from, to, value };
      return false;
    }
    return;
  });
  return hit;
}

/** The atomic span ending exactly at `pos`, if any. */
function atomicEndingAt(state: EditorState, pos: number): AtomicHit | null {
  const st = state.field(visualField, false);
  if (!st || st.doc === null) return null;
  let hit: AtomicHit | null = null;
  st.built.atomics.between(Math.max(0, pos - 1), pos, (from, to, value) => {
    if (to === pos) {
      hit = { from, to, value };
      return false;
    }
    return;
  });
  return hit;
}

/** The atomic span starting exactly at `pos`, if any. */
function atomicStartingAt(state: EditorState, pos: number): AtomicHit | null {
  const st = state.field(visualField, false);
  if (!st || st.doc === null) return null;
  let hit: AtomicHit | null = null;
  st.built.atomics.between(pos, pos + 1, (from, to, value) => {
    if (from === pos && to > pos) {
      hit = { from, to, value };
      return false;
    }
    return;
  });
  return hit;
}

/** Snap a position strictly inside an atomic range to one of its edges. */
function canonicalPos(state: EditorState, pos: number, bias: number): number {
  for (let guard = 0; guard < 8; guard++) {
    const hit = atomicAt(state, pos);
    if (!hit) return pos;
    pos = bias < 0 ? hit.from : hit.to;
  }
  return pos;
}

/* ------------------------------------------------------------------ */
/* Transaction filter                                                  */
/* ------------------------------------------------------------------ */

function normalizeRange(state: EditorState, r: SelectionRange): SelectionRange {
  const head = canonicalPos(state, r.head, r.head >= r.anchor ? 1 : -1);
  const anchor = r.empty
    ? head
    : canonicalPos(state, r.anchor, r.anchor > r.head ? 1 : -1);
  if (head === r.head && anchor === r.anchor) return r;
  return r.empty ? EditorSelection.cursor(head) : EditorSelection.range(anchor, head);
}

/**
 * Rewrite one user deletion range to construct closure: constructs fully
 * inside the deletion go whole; a construct only partially covered keeps
 * ALL its atomic pieces (only the visible content between them is deleted).
 */
function closureDeletion(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number }[] {
  const st = state.field(visualField, false);
  if (!st || st.doc === null) return [{ from, to }];
  const keep: { from: number; to: number }[] = [];
  st.built.atomics.between(from, to, (aFrom, aTo, value) => {
    const overlaps = aFrom < to && aTo > from;
    if (!overlaps) return;
    const constructInside = value.cFrom >= from && value.cTo <= to;
    if (!constructInside) {
      keep.push({ from: Math.max(aFrom, from), to: Math.min(aTo, to) });
    }
  });
  if (keep.length === 0) return [{ from, to }];
  keep.sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  let cursor = from;
  for (const k of keep) {
    if (k.from > cursor) out.push({ from: cursor, to: k.from });
    cursor = Math.max(cursor, k.to);
  }
  if (cursor < to) out.push({ from: cursor, to });
  return out;
}

const guardFilter = EditorState.transactionFilter.of((tr) => {
  const st = tr.startState.field(visualField, false);
  if (!st || st.doc === null) return tr;
  if (tr.annotation(visualEdit)) return tr;
  if (tr.isUserEvent("input.type.compose")) return tr;

  // Selection-only transactions: collapse multi-range, snap out of atomics.
  if (!tr.docChanged) {
    if (!tr.selection) return tr;
    const main = normalizeRange(tr.startState, tr.selection.main);
    if (
      tr.selection.ranges.length === 1 &&
      main === tr.selection.main
    ) {
      return tr;
    }
    return [
      tr,
      { selection: EditorSelection.create([main]), sequential: true },
    ];
  }

  const isUser =
    tr.isUserEvent("input") ||
    tr.isUserEvent("delete") ||
    tr.isUserEvent("move.drop");
  if (!isUser) return tr; // programmatic — the reparse absorbs it

  let rewrote = false;
  const changes: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (toA > fromA) {
      const pieces = closureDeletion(tr.startState, fromA, toA);
      if (pieces.length !== 1 || pieces[0].from !== fromA || pieces[0].to !== toA) {
        rewrote = true;
      }
      if (inserted.length > 0) {
        // Replacement: insert at the first kept piece (or original start).
        const insertAt = pieces[0] ?? { from: fromA, to: fromA };
        changes.push({ from: insertAt.from, to: insertAt.to, insert: inserted });
        for (let i = 1; i < pieces.length; i++) changes.push(pieces[i]);
      } else {
        for (const p of pieces) changes.push(p);
      }
    } else {
      // Pure insertion: relocate out of hidden spans.
      const hit = atomicAt(tr.startState, fromA);
      if (hit) {
        rewrote = true;
        const pos = fromA - hit.from <= hit.to - fromA ? hit.from : hit.to;
        changes.push({ from: pos, insert: inserted });
      } else {
        changes.push({ from: fromA, insert: inserted });
      }
    }
  });

  if (!rewrote) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    // No explicit selection: CM maps the start selection through the
    // REWRITTEN changes (the original tr.selection describes the original
    // geometry and would misplace the caret).
    changes,
    effects: tr.effects,
    annotations: [
      visualEdit.of(true),
      ...(userEvent ? [Transaction.userEvent.of(userEvent)] : []),
    ],
    scrollIntoView: tr.scrollIntoView,
  };
});

/* ------------------------------------------------------------------ */
/* Keymap                                                              */
/* ------------------------------------------------------------------ */

const dispatchEdit = (
  view: EditorView,
  spec: TransactionSpec,
  userEvent: string,
): boolean => {
  view.dispatch({
    ...spec,
    annotations: visualEdit.of(true),
    userEvent,
    scrollIntoView: true,
  });
  return true;
};

/** Word-style Backspace. */
function backspace(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false; // default selection delete → filter closes it
  const pos = sel.head;

  const behind = atomicEndingAt(state, pos);
  if (!behind) return false;
  const v = behind.value;

  switch (v.kind) {
    case "glyph":
    case "itemMarker":
      // Small chips and item markers delete in one press (marker deletion
      // merges the item's content into the previous item — Word behavior).
      return dispatchEdit(
        view,
        {
          changes: { from: v.cFrom, to: v.cTo },
          selection: EditorSelection.cursor(v.cFrom),
        },
        "delete.visual.construct",
      );
    case "widget":
    case "doc": {
      // Select first; a second press deletes the selection (via the filter's
      // whole-construct rule).
      if (sel.from === v.cFrom && sel.to === v.cTo) return false;
      view.dispatch({
        selection: EditorSelection.range(v.cFrom, v.cTo),
        userEvent: "select",
        annotations: visualEdit.of(true),
      });
      return true;
    }
    case "style":
    case "group":
    case "heading": {
      if (v.role === "close") {
        // Caret after the construct: delete the last content character, or
        // the whole construct once its content is empty.
        if (v.contentTo > v.contentFrom) {
          return dispatchEdit(
            view,
            {
              changes: { from: v.contentTo - 1, to: v.contentTo },
              selection: EditorSelection.cursor(v.contentTo - 1),
            },
            "delete.visual.content",
          );
        }
        return dispatchEdit(
          view,
          {
            changes: { from: v.cFrom, to: v.cTo },
            selection: EditorSelection.cursor(v.cFrom),
          },
          "delete.visual.construct",
        );
      }
      // Caret at content start (after the open wrapper).
      if (v.contentTo <= v.contentFrom) {
        // Empty construct → remove it whole.
        return dispatchEdit(
          view,
          {
            changes: { from: v.cFrom, to: v.cTo },
            selection: EditorSelection.cursor(v.cFrom),
          },
          "delete.visual.construct",
        );
      }
      if (v.kind === "heading") {
        // Word/Docs: Backspace at heading start unwraps it to a paragraph.
        return dispatchEdit(
          view,
          {
            changes: [
              { from: behind.from, to: behind.to },
              headingCloseChange(state, v),
            ],
            selection: EditorSelection.cursor(behind.from),
          },
          "delete.visual.unwrap",
        );
      }
      // Style/group content start: delete the character before the whole
      // construct (that's what the caret visually sits after).
      if (v.cFrom === 0) return true;
      return dispatchEdit(
        view,
        {
          changes: { from: v.cFrom - 1, to: v.cFrom },
          selection: EditorSelection.cursor(v.cFrom - 1),
        },
        "delete.visual.content",
      );
    }
    case "environment":
      // Backspace right after a hidden env token: nothing sensible to eat —
      // treat as no-op rather than corrupting (the filter would no-op it
      // anyway, this just avoids the attempt).
      return true;
  }
  return false;
}

/**
 * The heading's closing-wrapper span for an unwrap — trimmed to keep the
 * trailing newline (the unwrapped title must stay its own paragraph line,
 * not glue onto the following text).
 */
function headingCloseChange(state: EditorState, v: AtomicMarker): ChangeSpec {
  const closing = atomicStartingAt(state, v.contentTo);
  let from = v.contentTo;
  let to = v.cTo;
  if (closing && closing.value.cFrom === v.cFrom) {
    from = closing.from;
    to = closing.to;
  }
  if (to > from && state.doc.sliceString(to - 1, to) === "\n") to--;
  return { from, to };
}

/** Forward delete mirrors Backspace. */
function forwardDelete(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const ahead = atomicStartingAt(state, sel.head);
  if (!ahead) return false;
  const v = ahead.value;
  switch (v.kind) {
    case "glyph":
    case "itemMarker":
      return dispatchEdit(
        view,
        {
          changes: { from: v.cFrom, to: v.cTo },
          selection: EditorSelection.cursor(v.cFrom),
        },
        "delete.visual.construct",
      );
    case "widget":
    case "doc": {
      if (sel.from === v.cFrom && sel.to === v.cTo) return false;
      view.dispatch({
        selection: EditorSelection.range(v.cFrom, v.cTo),
        userEvent: "select",
        annotations: visualEdit.of(true),
      });
      return true;
    }
    case "style":
    case "group":
    case "heading": {
      if (v.role === "open") {
        if (v.contentTo > v.contentFrom) {
          return dispatchEdit(
            view,
            {
              changes: { from: v.contentFrom, to: v.contentFrom + 1 },
              selection: EditorSelection.cursor(v.contentFrom),
            },
            "delete.visual.content",
          );
        }
        return dispatchEdit(
          view,
          {
            changes: { from: v.cFrom, to: v.cTo },
            selection: EditorSelection.cursor(v.cFrom),
          },
          "delete.visual.construct",
        );
      }
      return true;
    }
    case "environment":
      return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Enter                                                               */
/* ------------------------------------------------------------------ */

interface EnterContext {
  kind: "heading" | "item" | "blankish" | "paragraph";
  /** Heading: the construct; item: the marker block span. */
  cFrom?: number;
  cTo?: number;
  contentFrom?: number;
  contentTo?: number;
}

function enterContext(state: EditorState, pos: number): EnterContext {
  const st = state.field(visualField, false);
  if (!st || st.doc === null) return { kind: "paragraph" };
  const doc = st.doc;

  // Inside a heading's content?
  const behind = atomicEndingAt(state, pos);
  const around = atomicAt(state, pos);
  const headingHit =
    (behind?.value.kind === "heading" && behind.value) ||
    (around?.value.kind === "heading" && around.value) ||
    null;
  if (headingHit) {
    return {
      kind: "heading",
      cFrom: headingHit.cFrom,
      cTo: headingHit.cTo,
      contentFrom: headingHit.contentFrom,
      contentTo: headingHit.contentTo,
    };
  }

  const block = blockAt(doc, Math.min(pos, doc.length - 1));
  if (!block) return { kind: "blankish" };
  if (block.kind === "heading") {
    return {
      kind: "heading",
      cFrom: block.from,
      cTo: block.to,
      contentFrom: block.content.from,
      contentTo: block.content.to,
    };
  }
  if (block.kind === "blank" || block.kind === "commentLine" || block.kind === "rawSource") {
    return { kind: "blankish" };
  }
  if (block.kind === "environment" && block.envKind === "verbatim") {
    return { kind: "blankish" };
  }

  // Paragraph inside a list (after an item marker) → item semantics.
  if (itemContextAt(doc, pos)) return { kind: "item" };
  return { kind: "paragraph" };
}

/** True when `pos` falls in list-item content at any nesting depth. */
function itemContextAt(doc: VisualDoc, pos: number): boolean {
  const walk = (blocks: BlockNode[], inList: boolean): boolean | null => {
    for (const b of blocks) {
      if (pos < b.from || pos >= b.to) continue;
      if (b.kind === "environment") {
        const childInList = b.envKind === "list";
        if (b.children) {
          const nested = walk(b.children, childInList);
          if (nested !== null) return nested;
        }
        return childInList && pos >= b.body.from && pos < b.body.to;
      }
      if (b.kind === "itemMarker") return true;
      return inList && (b.kind === "paragraph" || b.kind === "blank");
    }
    return null;
  };
  return walk(doc.blocks, false) ?? false;
}

function enter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const pos = sel.head;
  const ctx = enterContext(state, pos);

  switch (ctx.kind) {
    case "heading": {
      const contentTo = ctx.contentTo ?? pos;
      const cTo = ctx.cTo ?? pos;
      if (pos >= contentTo) {
        // End of title → fresh paragraph line below the heading.
        return dispatchEdit(
          view,
          {
            changes: { from: cTo, insert: "\n" },
            selection: EditorSelection.cursor(cTo),
          },
          "input.visual.exit",
        );
      }
      if (pos <= (ctx.contentFrom ?? pos)) {
        // Start of title → empty paragraph above.
        return dispatchEdit(
          view,
          {
            changes: { from: ctx.cFrom ?? pos, insert: "\n" },
            selection: EditorSelection.cursor((ctx.cFrom ?? pos) + 1),
          },
          "input.visual.exit",
        );
      }
      // Mid-title → split into two headings of the same level.
      const st = state.field(visualField, false);
      const block = st?.doc ? blockAt(st.doc, ctx.cFrom ?? pos) : null;
      if (block?.kind === "heading") {
        const cmd = state.doc.sliceString(block.hide[0].from, block.content.from);
        return dispatchEdit(
          view,
          {
            changes: { from: pos, insert: `}\n${cmd.replace(/\{\s*$/, "{")}` },
          },
          "input.visual.split",
        );
      }
      return dispatchEdit(
        view,
        { changes: { from: pos, insert: "\n" } },
        "input.visual.split",
      );
    }
    case "item": {
      if (sel.empty) {
        return dispatchEdit(
          view,
          { changes: { from: pos, to: sel.to, insert: "\n\\item " } },
          "input.visual.split",
        );
      }
      return false;
    }
    case "blankish":
      return dispatchEdit(
        view,
        { changes: { from: sel.from, to: sel.to, insert: "\n" } },
        "input.visual.newline",
      );
    case "paragraph":
      // New paragraph = blank-line separator (matches the compiled output).
      return dispatchEdit(
        view,
        { changes: { from: sel.from, to: sel.to, insert: "\n\n" } },
        "input.visual.split",
      );
  }
  return false;
}

function shiftEnter(view: EditorView): boolean {
  const sel = view.state.selection.main;
  return dispatchEdit(
    view,
    { changes: { from: sel.from, to: sel.to, insert: "\\\\\n" } },
    "input.visual.break",
  );
}

/* ------------------------------------------------------------------ */
/* Input handler — TeX specials typed in prose insert escaped forms    */
/* ------------------------------------------------------------------ */

const INPUT_ESCAPES: Record<string, string> = {
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "\\": "\\textbackslash{}",
};

const escapeInput = EditorView.inputHandler.of((view, from, to, text) => {
  const st = view.state.field(visualField, false);
  if (!st || st.doc === null) return false;
  // Inside verbatim/comment/rawSource content the literal char is correct.
  const block = blockAt(st.doc, Math.min(from, st.doc.length - 1));
  if (
    block &&
    (block.kind === "commentLine" ||
      block.kind === "rawSource" ||
      (block.kind === "environment" && block.envKind === "verbatim"))
  ) {
    return false;
  }
  if (text === "$") {
    // LaTeX muscle memory: `$` starts math — open the new-math popover
    // instead of inserting a literal dollar (that lives in the popover).
    const cfg = view.state.facet(visualConfig);
    if (cfg.onOpenPopover) {
      cfg.onOpenPopover({ from, to: from, kind: "newMath" });
      return true;
    }
    return false;
  }
  const escaped = INPUT_ESCAPES[text];
  if (escaped === undefined) return false;
  view.dispatch({
    changes: { from, to, insert: escaped },
    selection: EditorSelection.cursor(from + escaped.length),
    annotations: visualEdit.of(true),
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return true;
});

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export function visualEditGuards(): Extension {
  return [
    guardFilter,
    escapeInput,
    Prec.highest(
      keymap.of([
        { key: "Backspace", run: backspace },
        { key: "Delete", run: forwardDelete },
        { key: "Enter", run: enter },
        { key: "Shift-Enter", run: shiftEnter },
      ]),
    ),
  ];
}

/** Command handlers exposed for the jsdom suite (not part of the API). */
export const guardCommandsForTests = {
  backspace,
  forwardDelete,
  enter,
  shiftEnter,
};

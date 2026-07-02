import {
  StateField,
  StateEffect,
  RangeSet,
  RangeValue,
  MapMode,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { CommentThread } from "~/lib/reviews/types";
import { recoverThreads } from "~/lib/reviews/recovery";

class CommentMark extends RangeValue {
  startSide = 1;
  endSide = -1;
  point = false;
  mapMode = MapMode.TrackDel;

  constructor(
    public threadId: string,
    public status: "open" | "resolved",
  ) {
    super();
  }

  eq(other: RangeValue): boolean {
    return (
      other instanceof CommentMark &&
      this.threadId === other.threadId &&
      this.status === other.status
    );
  }
}

interface ThreadInput {
  id: string;
  from: number;
  to: number;
  status: "open" | "resolved";
}

const setThreads = StateEffect.define<ThreadInput[]>();

function buildRangeSet(
  threads: ThreadInput[],
  docLength: number,
): RangeSet<CommentMark> {
  const valid = threads
    .filter((t) => t.from >= 0 && t.to <= docLength && t.from < t.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  if (valid.length === 0) return RangeSet.empty;
  const ranges: Range<CommentMark>[] = valid.map((t) =>
    new CommentMark(t.id, t.status).range(t.from, t.to),
  );
  return RangeSet.of(ranges, true);
}

const commentField = StateField.define<RangeSet<CommentMark>>({
  create() {
    return RangeSet.empty;
  },
  update(rangeSet, tr) {
    for (const e of tr.effects) {
      if (e.is(setThreads)) {
        return buildRangeSet(e.value, tr.state.doc.length);
      }
    }
    if (tr.docChanged) {
      return rangeSet.map(tr.changes);
    }
    return rangeSet;
  },
});

const openDeco = Decoration.mark({ class: "cm-review-anchor-open" });
const resolvedDeco = Decoration.mark({ class: "cm-review-anchor-resolved" });

const commentDecorations = EditorView.decorations.compute(
  [commentField],
  (state) => {
    const ranges = state.field(commentField);
    const decos: Range<Decoration>[] = [];
    const cursor = ranges.iter();
    while (cursor.value) {
      const deco = cursor.value.status === "open" ? openDeco : resolvedDeco;
      decos.push(deco.range(cursor.from, cursor.to));
      cursor.next();
    }
    return Decoration.set(decos, true);
  },
);

class CommentGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-review-gutter-marker";
    el.textContent = "○";
    el.title = "Review comment";
    return el;
  }
}

const singleMarker = new CommentGutterMarker();

const commentGutter = gutter({
  class: "cm-review-gutter",
  markers(view) {
    const ranges = view.state.field(commentField);
    const seen = new Set<number>();
    const markers: Range<GutterMarker>[] = [];
    const cursor = ranges.iter();
    while (cursor.value) {
      const lineFrom = view.state.doc.lineAt(cursor.from).from;
      if (!seen.has(lineFrom)) {
        seen.add(lineFrom);
        markers.push(singleMarker.range(lineFrom));
      }
      cursor.next();
    }
    return RangeSet.of(markers, true);
  },
});

export interface ReviewExtensionCallbacks {
  onOffsetsChanged: (
    updates: Array<{
      id: string;
      from: number;
      to: number;
      anchorText: string;
    }>,
  ) => void;
  onGutterClick: (threadId: string) => void;
}

function persistenceBridge(callbacks: ReviewExtensionCallbacks): Extension {
  return ViewPlugin.fromClass(
    class {
      view: EditorView;
      debounceTimer: ReturnType<typeof setTimeout> | null = null;

      constructor(view: EditorView) {
        this.view = view;
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.flush();
        }, 2_000);
      }

      flush() {
        const ranges = this.view.state.field(commentField);
        const doc = this.view.state.doc;
        const updates: Array<{
          id: string;
          from: number;
          to: number;
          anchorText: string;
        }> = [];
        const cursor = ranges.iter();
        while (cursor.value) {
          updates.push({
            id: cursor.value.threadId,
            from: cursor.from,
            to: cursor.to,
            anchorText: doc.sliceString(cursor.from, cursor.to).slice(0, 80),
          });
          cursor.next();
        }
        if (updates.length > 0) {
          callbacks.onOffsetsChanged(updates);
        }
      }

      destroy() {
        // Tab switches remount the editor per file; dropping a pending remap
        // would silently discard up to 2s of offset updates and leave the
        // store anchoring against stale positions. Flush instead of drop.
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
          this.flush();
        }
      }
    },
  );
}

function gutterClickHandler(callbacks: ReviewExtensionCallbacks): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("cm-review-gutter-marker")) return false;
      const pos = view.posAtDOM(target);
      const lineFrom = view.state.doc.lineAt(pos).from;
      const ranges = view.state.field(commentField);
      const cursor = ranges.iter();
      while (cursor.value) {
        if (view.state.doc.lineAt(cursor.from).from === lineFrom) {
          callbacks.onGutterClick(cursor.value.threadId);
          return true;
        }
        cursor.next();
      }
      return false;
    },
  });
}

export function reviewExtension(
  callbacks: ReviewExtensionCallbacks,
): Extension[] {
  return [
    commentField,
    commentDecorations,
    commentGutter,
    persistenceBridge(callbacks),
    gutterClickHandler(callbacks),
  ];
}

export function dispatchSetThreads(
  view: EditorView,
  threads: ThreadInput[],
): void {
  view.dispatch({ effects: setThreads.of(threads) });
}

function rangesEqual(
  desired: ThreadInput[],
  current: Map<string, { from: number; to: number; status: "open" | "resolved" }>,
): boolean {
  if (desired.length !== current.size) return false;
  for (const d of desired) {
    const c = current.get(d.id);
    if (!c || c.from !== d.from || c.to !== d.to || c.status !== d.status) {
      return false;
    }
  }
  return true;
}

/**
 * Reconcile the editor's comment decorations against the review store, which
 * is the single source of truth for which threads exist and their status.
 *
 * Live anchor positions (mapped through edits by CodeMirror's RangeSet) win
 * for threads already present in the view; only brand-new threads are placed
 * by recovering their store offset against the current document. A dispatch
 * fires only when the derived set actually differs from what's rendered, so
 * calling this on every store change (including per-keystroke re-runs of the
 * driving effect) is cheap and never clobbers live positions.
 */
export function syncThreadsToView(
  view: EditorView,
  storeThreads: CommentThread[],
  fileRelPath: string,
  fileContent: string,
): void {
  const current = new Map(
    getCurrentRanges(view).map((r) => [r.id, r] as const),
  );
  const fileThreads = storeThreads.filter((t) => t.fileRelPath === fileRelPath);

  const desired: ThreadInput[] = [];
  const absent: CommentThread[] = [];
  for (const t of fileThreads) {
    const live = current.get(t.id);
    if (live) {
      desired.push({ id: t.id, from: live.from, to: live.to, status: t.status });
    } else {
      absent.push(t);
    }
  }
  if (absent.length > 0) {
    for (const r of recoverThreads(absent, fileContent, fileRelPath)) {
      if (r.recoveryStatus === "orphaned") continue;
      desired.push({
        id: r.thread.id,
        from: r.fromOffset,
        to: r.toOffset,
        status: r.thread.status,
      });
    }
  }

  if (rangesEqual(desired, current)) return;
  dispatchSetThreads(view, desired);
}

export function getCurrentRanges(view: EditorView): Array<{
  id: string;
  from: number;
  to: number;
  status: "open" | "resolved";
}> {
  const ranges = view.state.field(commentField);
  const result: Array<{
    id: string;
    from: number;
    to: number;
    status: "open" | "resolved";
  }> = [];
  const cursor = ranges.iter();
  while (cursor.value) {
    result.push({
      id: cursor.value.threadId,
      from: cursor.from,
      to: cursor.to,
      status: cursor.value.status,
    });
    cursor.next();
  }
  return result;
}

export { commentField };

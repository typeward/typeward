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
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const ranges = update.state.field(commentField);
          const doc = update.state.doc;
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
        }, 2_000);
      }

      destroy() {
        if (debounceTimer) clearTimeout(debounceTimer);
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

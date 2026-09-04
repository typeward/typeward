/**
 * The visual mode's core state: the parse tree + its decorations/atomics,
 * updated synchronously inside every transaction. On a budget abort the
 * PREVIOUS decorations are offset-mapped through the changes (never cleared
 * — a cleared frame would paint raw markup), and a maintenance plugin
 * schedules an idle full reparse; repeated aborts escalate to the pause
 * callback (the host drops the file to source mode for the session).
 */

import {
  Annotation,
  Facet,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import type { Text } from "@codemirror/state";

import type { AtomicMarker, BuiltDecorations } from "./decorations";
import { buildDecorations } from "./decorations";
import type { Doc, VisualDoc } from "./parse";
import {
  assertTotalCoverage,
  parseVisualDoc,
  passesSizeGate,
  updateDoc,
} from "./parse";

/** Adapt a CM6 `Text` to the parse layer's CM-free `Doc` source, so the
 *  incremental update materializes only the region it rescans. */
function docSource(text: Text): Doc {
  return {
    length: text.length,
    sliceString: (from, to) => text.sliceString(from, to),
    lineStartAt: (pos) => text.lineAt(pos).from,
  };
}

export interface VisualConfig {
  /** Parse budget blown for good — host pauses the file. */
  onPause?: () => void;
  /** A widget was clicked / activated — host opens the edit popover. */
  onOpenPopover?: (intent: PopoverIntent) => void;
  /**
   * Resolve a project-relative asset path to a display URL (figure
   * previews). Host-provided so the layer stays project-agnostic; the
   * traversal/absolute-path guards live in src/lib/file-url.ts.
   */
  resolveAsset?: (relPath: string) => string | null;
}

export interface PopoverIntent {
  /** Construct span at open time (the host maps it while open). */
  from: number;
  to: number;
  /** Coarse construct family for the popover header. */
  kind: string;
}

export const visualConfig = Facet.define<VisualConfig, VisualConfig>({
  combine: (values) => values[0] ?? {},
});

/** Marks transactions the visual layer itself sanctioned (popover Apply,
 * structural keymap edits) — the guards wave them through. */
export const visualEdit = Annotation.define<boolean>();

/** Delivers an idle full reparse result. */
export const setVisualDocEffect = StateEffect.define<VisualDoc>();

export interface VisualState {
  /** Null = enable-time abort; the maintenance plugin pauses the file. */
  doc: VisualDoc | null;
  built: BuiltDecorations;
  /** Consecutive stale (budget-aborted) updates. */
  staleCount: number;
}

const DEV = typeof import.meta !== "undefined" && !!import.meta.env?.DEV;

/** Consecutive stale updates (or idle-reparse failures) before pausing. */
const PAUSE_AFTER_STALE = 3;

export const visualField = StateField.define<VisualState>({
  create(state) {
    const text = state.doc.toString();
    if (!passesSizeGate(text)) {
      return { doc: null, built: emptyBuilt(), staleCount: 0 };
    }
    const doc = parseVisualDoc(text);
    if (doc === null) {
      return { doc: null, built: emptyBuilt(), staleCount: 0 };
    }
    if (DEV) assertTotalCoverage(doc);
    return {
      doc,
      built: buildDecorations(doc, state.doc, state.facet(visualConfig)),
      staleCount: 0,
    };
  },

  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setVisualDocEffect)) {
        const doc = e.value;
        if (DEV && !doc.stale) assertTotalCoverage(doc);
        return {
          doc,
          built: buildDecorations(doc, tr.state.doc, tr.state.facet(visualConfig)),
          staleCount: 0,
        };
      }
    }
    if (!tr.docChanged || value.doc === null) return value;

    const result = updateDoc(value.doc, tr.changes, docSource(tr.newDoc));
    if (result.stale) {
      // Never clear: mapped decorations keep every unchanged region hidden
      // (offsets shift exactly); the changed region may render approximately
      // for a frame until the idle reparse lands.
      return {
        doc: result.doc,
        built: {
          decorations: value.built.decorations.map(tr.changes),
          atomics: value.built.atomics.map(tr.changes),
        },
        staleCount: value.staleCount + 1,
      };
    }
    if (DEV) assertTotalCoverage(result.doc);
    return {
      doc: result.doc,
      built: buildDecorations(result.doc, tr.newDoc, tr.state.facet(visualConfig)),
      staleCount: 0,
    };
  },

  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.built.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).built.atomics),
  ],
});

function emptyBuilt(): BuiltDecorations {
  return {
    decorations: Decoration.none,
    atomics: RangeSet.empty as RangeSet<AtomicMarker>,
  };
}

/**
 * Maintenance: enable-time pause, idle reparse after stale updates, pause
 * escalation. Dispatches happen asynchronously — never inside update().
 */
export const visualMaintenance = ViewPlugin.fromClass(
  class {
    private idleScheduled = false;
    private pauseNotified = false;
    private destroyed = false;

    constructor(readonly view: EditorView) {
      const st = view.state.field(visualField);
      if (st.doc === null) this.notifyPause();
    }

    update(u: ViewUpdate): void {
      const st = u.state.field(visualField);
      if (st.doc === null) {
        this.notifyPause();
        return;
      }
      if (st.staleCount >= PAUSE_AFTER_STALE) {
        this.notifyPause();
        return;
      }
      if (st.doc.stale) this.scheduleIdleReparse();
    }

    destroy(): void {
      this.destroyed = true;
    }

    private notifyPause(): void {
      if (this.pauseNotified) return;
      this.pauseNotified = true;
      const cfg = this.view.state.facet(visualConfig);
      queueMicrotask(() => cfg.onPause?.());
    }

    private scheduleIdleReparse(): void {
      if (this.idleScheduled || this.pauseNotified) return;
      this.idleScheduled = true;
      const run = () => {
        this.idleScheduled = false;
        if (this.destroyed || this.pauseNotified) return;
        const state = this.view.state;
        const st = state.field(visualField, false);
        if (!st || st.doc === null || !st.doc.stale) return;
        // A generous budget — this runs off the typing path.
        const doc = parseVisualDoc(state.doc.toString(), { budgetMs: 80 });
        if (this.view.state !== state) {
          // The document moved on while parsing — try again from fresh.
          if (doc !== null) this.scheduleIdleReparse();
          else this.notifyPause();
          return;
        }
        if (doc === null) {
          this.notifyPause();
          return;
        }
        this.view.dispatch({
          effects: setVisualDocEffect.of(doc),
          annotations: visualEdit.of(true),
        });
      };
      type IdleWindow = typeof globalThis & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      const w = globalThis as IdleWindow;
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(run, { timeout: 200 });
      } else {
        setTimeout(run, 50);
      }
    }
  },
);

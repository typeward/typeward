import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { visualConfig, visualField, visualMaintenance } from "./field";
import type { PopoverIntent, VisualConfig } from "./field";
import { visualClipboard } from "./clipboard";
import { visualEditGuards } from "./edit-guards";
import { visualSearch } from "./search";
import { constructTheme, documentTheme } from "./theme";

export type { PopoverIntent, VisualConfig } from "./field";
export { visualEdit, visualField } from "./field";

/**
 * Visual editing mode for LaTeX — hidden-source WYSIWYG.
 *
 * Contract with the host (CodeMirror.tsx):
 * - Mounted/unmounted through a compartment; mounting and unmounting must
 *   dispatch ZERO document changes (the zero-corruption invariant — the
 *   layer decorates and guards, it never rewrites the document wholesale).
 * - `onPause` is raised when the parse budget aborts; the host flips the
 *   file to source mode for the session (visual-store).
 * - `onOpenPopover` is raised when a widget is activated; the host mounts
 *   the editing popover (markup appears only there).
 *
 * The extension is dynamic-imported on first enable so the parser, guards,
 * and widget code stay off the boot path.
 */
export function visualExtension(cfg: VisualConfig = {}): Extension {
  return [
    visualConfig.of(cfg),
    visualField,
    visualMaintenance,
    visualEditGuards(),
    visualSearch(),
    visualClipboard(),
    widgetActivation(),
    documentTheme,
    constructTheme,
  ];
}

/**
 * Widget clicks: resolve the construct at the event position and raise the
 * popover intent (single handler — widgets set `ignoreEvent() => false`
 * instead of carrying their own listeners).
 */
function widgetActivation(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      const widgetEl = target.closest(
        ".cm-vis-chip, .cm-vis-card, .cm-vis-preamble, .cm-vis-math, .cm-vis-table, .cm-vis-figure",
      );
      if (!widgetEl) return false;
      const pos = view.posAtDOM(widgetEl);
      const st = view.state.field(visualField, false);
      if (!st || st.doc === null) return false;
      let intent: PopoverIntent | null = null;
      st.built.atomics.between(pos, pos + 1, (_from, _to, value) => {
        intent = { from: value.cFrom, to: value.cTo, kind: value.kind };
        return false;
      });
      if (!intent) return false;
      const found: PopoverIntent = intent;
      // Select the construct (SyncTeX forward + delete flows key off it),
      // then hand off to the host popover.
      view.dispatch({
        selection: { anchor: found.from, head: found.to },
        userEvent: "select",
        scrollIntoView: true,
      });
      view.state.facet(visualConfig).onOpenPopover?.(found);
      event.preventDefault();
      return true;
    },
  });
}

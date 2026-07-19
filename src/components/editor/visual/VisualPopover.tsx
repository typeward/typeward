import katex from "katex";
import type { Component } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { installDismiss } from "~/lib/dismiss";
import { notifyError } from "~/lib/toast";
import { getActiveEditorView } from "~/stores/editor-view-store";
import {
  clearVisualPopover,
  visualPopoverIntent,
  type VisualPopoverIntent,
} from "~/stores/visual-store";
import { MiniLatexEditor } from "./MiniLatexEditor";

/**
 * The click-to-edit popover — the ONE surface where LaTeX source is meant
 * to be visible in visual mode. Mounted once in CenterPane; opens when the
 * visual layer raises a popover intent (widget click, `$`).
 *
 * Apply safety (the AI-dialog guard pattern): the construct's source is
 * snapshotted at open; Apply re-validates that the snapshot still sits at
 * the recorded span — if the document moved underneath (idle reparse can't
 * move text, but sync adoption or an external write can), it searches
 * nearby for the snapshot and otherwise refuses with a toast instead of
 * clobbering unknown text.
 */

const HEADER: Record<string, string> = {
  newMath: "Insert math",
  widget: "Edit LaTeX",
  doc: "Document settings (preamble)",
  glyph: "Edit LaTeX",
};

const MATHY_PREFIXES = ["$", "\\[", "\\begin{align", "\\begin{equation", "\\begin{gather", "\\begin{multline", "\\begin{eqnarray"];

export const VisualPopover: Component = () => {
  const intent = visualPopoverIntent;

  return (
    <Show when={intent()} keyed>
      {(open) => <PopoverBody intent={open} />}
    </Show>
  );
};

const PopoverBody: Component<{ intent: VisualPopoverIntent }> = (props) => {
  let root!: HTMLDivElement;
  const view = getActiveEditorView();
  const isNew = props.intent.kind === "newMath";
  const snapshot = isNew
    ? ""
    : (view?.state.doc.sliceString(props.intent.from, props.intent.to) ?? "");
  const [draft, setDraft] = createSignal(snapshot);

  // Position near the construct; clamped to the viewport.
  const coords = view?.coordsAtPos(props.intent.from) ?? null;
  const top = coords ? Math.min(coords.bottom + 8, window.innerHeight - 260) : 120;
  const left = coords ? Math.min(Math.max(coords.left - 20, 12), window.innerWidth - 460) : 120;

  const showPreview = createMemo(() => {
    const d = draft().trimStart();
    return (
      isNew || MATHY_PREFIXES.some((p) => snapshot.trimStart().startsWith(p)) || d.startsWith("$")
    );
  });

  const previewHtml = createMemo(() => {
    if (!showPreview()) return null;
    const src = isNew ? draft() : stripMathShell(draft());
    if (src.trim() === "") return null;
    try {
      return katex.renderToString(src, {
        displayMode: !isNew && snapshot.trimStart().startsWith("\\["),
        throwOnError: true,
        trust: false,
      });
    } catch {
      return null;
    }
  });

  const close = (): void => {
    clearVisualPopover();
    view?.focus();
  };

  installDismiss(
    () => root,
    () => true,
    close,
  );

  const apply = (): void => {
    const v = getActiveEditorView();
    if (!v) return close();
    const text = draft();
    if (isNew) {
      const insert = text.trim() === "" ? "" : `$${text.trim()}$`;
      if (insert !== "") {
        v.dispatch({
          changes: { from: props.intent.from, to: props.intent.from, insert },
          selection: { anchor: props.intent.from + insert.length },
          scrollIntoView: true,
        });
      }
      return close();
    }
    // Re-validate the span against the open-time snapshot.
    let { from, to } = props.intent;
    const current = v.state.doc.sliceString(from, to);
    if (current !== snapshot) {
      const windowFrom = Math.max(0, from - 2000);
      const windowTo = Math.min(v.state.doc.length, to + 2000);
      const around = v.state.doc.sliceString(windowFrom, windowTo);
      const found = around.indexOf(snapshot);
      if (snapshot === "" || found === -1) {
        notifyError(
          "Couldn't apply the edit",
          "The document changed while the editor was open — the construct moved or was removed.",
        );
        return close();
      }
      from = windowFrom + found;
      to = from + snapshot.length;
    }
    if (text !== snapshot) {
      v.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
    }
    close();
  };

  return (
    <div
      ref={root!}
      class="fixed z-50 flex w-[440px] max-w-[92vw] flex-col gap-2 rounded-lg p-3 shadow-lg"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        background: "var(--color-popover-bg)",
        border: "1px solid var(--color-glass-stroke)",
        "box-shadow": "var(--shadow-glass-drop)",
      }}
      role="dialog"
      aria-label={HEADER[props.intent.kind] ?? "Edit LaTeX"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium" style={{ color: "var(--color-fg-3)" }}>
          {HEADER[props.intent.kind] ?? "Edit LaTeX"}
        </span>
        <span class="text-[10px]" style={{ color: "var(--color-fg-4)" }}>
          Mod+Enter to apply
        </span>
      </div>
      <MiniLatexEditor initial={snapshot} onChange={setDraft} onSubmit={apply} />
      <Show when={previewHtml()}>
        {(html) => (
          <div
            class="scroll max-h-40 overflow-auto rounded-md px-3 py-2"
            style={{ background: "var(--color-control-fill)" }}
            // eslint-disable-next-line solid/no-innerhtml -- KaTeX output for
            // a math-only string with trust:false; the .md preview pipes the
            // same renderer through its sanitizer because there the INPUT is
            // arbitrary HTML — here it is TeX that KaTeX fully controls.
            innerHTML={html()}
          />
        )}
      </Show>
      <div class="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  );
};

/** For the preview only: unwrap `$…$`/`\[…\]`/math-env shells to bare TeX. */
function stripMathShell(src: string): string {
  const s = src.trim();
  if (s.startsWith("$$") && s.endsWith("$$")) return s.slice(2, -2);
  if (s.startsWith("$") && s.endsWith("$") && s.length > 1) return s.slice(1, -1);
  if (s.startsWith("\\[") && s.endsWith("\\]")) return s.slice(2, -2);
  if (s.startsWith("\\(") && s.endsWith("\\)")) return s.slice(2, -2);
  const env = /^\\begin\{([a-zA-Z*]+)\}([\s\S]*)\\end\{\1\}$/.exec(s);
  if (env) return `\\begin{aligned}${env[2].replace(/\\label\{[^}]*\}/g, "")}\\end{aligned}`;
  return s;
}

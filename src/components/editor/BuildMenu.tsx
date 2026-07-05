import { ChevronUp } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { effectiveBuild } from "~/adapters/latex/build-config";
import {
  BuildConfigMenu,
  ENGINE_LABEL,
} from "~/components/editor/BuildConfigMenu";
import { openProjectSettings } from "~/components/editor/ProjectSettingsDialog";
import { installDismiss } from "~/lib/dismiss";
import { useListboxOpenFocus } from "~/lib/listbox-nav";
import { project } from "~/stores/editor-store";

/**
 * Bottom status-bar trigger for a LaTeX project's per-project build config. The
 * popover ({@link BuildConfigMenu}) opens upward; the shared component owns the
 * engine/recipe lists, flag toggles, and persistence, so the pill and this
 * status-bar entry stay in sync.
 */
export const BuildMenu: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  useListboxOpenFocus(open, () => rootRef);

  const eff = () => {
    const p = project();
    return p ? effectiveBuild(p) : null;
  };

  return (
    <div class="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open()}
        title="Build settings"
        class="lift flex h-5 items-center gap-1 rounded px-1.5 hover:bg-[var(--color-control-fill)]"
      >
        <span class="mono">
          {ENGINE_LABEL[eff()?.engine ?? "pdflatex"] ?? eff()?.engine}
        </span>
        <ChevronUp size={9} class="opacity-50" />
      </button>
      <Show when={open()}>
        <BuildConfigMenu
          direction="up"
          onClose={() => setOpen(false)}
          onOpenSettings={openProjectSettings}
        />
      </Show>
    </div>
  );
};

import { useNavigate } from "@solidjs/router";
import { ArrowLeft, ChevronDown, FolderOpen } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { installDismiss } from "~/lib/dismiss";
import { project } from "~/stores/editor-store";
import { projects } from "~/stores/projects-store";

/**
 * Editor top-bar pill — shows the current project name, opens a dropdown of
 * recent projects on click. Bottom item routes back to /projects.
 *
 * "Recent" here is just the projects-store list (already sorted by Rust
 * listing), de-duped against the current project. A real most-recently-used
 * tracker lives in Phase 4 when sync metadata exists.
 */
export const ProjectSwitcherMenu: Component<{
  onBack: () => void;
}> = (props) => {
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  const onTrigger = () => setOpen((v) => !v);

  const others = () =>
    projects()
      .filter((p) => p.rootPath !== project()?.rootPath)
      .slice(0, 6);

  const choose = (rootPath: string) => {
    setOpen(false);
    navigate(`/editor?path=${encodeURIComponent(rootPath)}`);
  };

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        onClick={onTrigger}
        class="lift flex h-7 items-center gap-1.5 rounded-md px-2.5 hover:bg-[var(--color-control-fill)]"
      >
        <span class="flex h-4 w-4 items-center justify-center rounded-[5px] accent-grad">
          <span class="text-[9px] font-bold">τ</span>
        </span>
        <span class="text-[length:var(--ui-font-sm)] font-semibold tracking-tight text-fg-1">
          {project()?.name ?? "—"}
        </span>
        <ChevronDown size={11} class="opacity-50" />
      </button>
      <Show when={open()}>
        <div
          class="glass absolute left-0 top-full z-50 mt-1 w-[260px] rounded-xl"
          style={{
            padding: "var(--ui-pad-section)",
            background: "var(--color-popover-bg)",
          }}
        >
          <div class="mb-1.5 flex items-center justify-between px-1">
            <span class="label-xs text-fg-3">Recent</span>
            <span class="mono text-[10px] text-fg-4">{others().length}</span>
          </div>
          <Show
            when={others().length > 0}
            fallback={
              <div class="px-2 py-3 text-[length:var(--ui-font-sm)] text-fg-3">
                No other projects yet.
              </div>
            }
          >
            <For each={others()}>
              {(p) => (
                <button
                  type="button"
                  onClick={() => choose(p.rootPath)}
                  class="lift flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-[var(--color-control-fill)]"
                >
                  <FolderOpen size={12} class="text-fg-3" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                      {p.name}
                    </div>
                    <div class="mono mt-0.5 truncate text-[10px] text-fg-3">
                      {p.rootFile}
                    </div>
                  </div>
                </button>
              )}
            </For>
          </Show>
          <div class="my-1.5 h-px" style={{ background: "var(--color-control-stroke)" }} />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              props.onBack();
            }}
            class="lift flex w-full items-center gap-2 rounded-md p-2 text-left text-[length:var(--ui-font-sm)] text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <ArrowLeft size={12} class="text-fg-3" />
            <span>Back to all projects</span>
          </button>
        </div>
      </Show>
    </div>
  );
};

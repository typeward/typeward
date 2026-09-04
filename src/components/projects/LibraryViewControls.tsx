import { ChevronDown, LayoutGrid, List } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import {
  type ProjectsSort,
  type ProjectsView,
  defaultSort,
  defaultView,
  setDefaultSort,
  setDefaultView,
} from "~/stores/workspace-store";

const SORT_LABEL: Record<ProjectsSort, string> = {
  "last-opened": "Last opened",
  name: "Name (A–Z)",
  "name-desc": "Name (Z–A)",
  created: "Date created",
  modified: "Last modified",
  deadline: "Deadline",
  format: "Format",
};

const AVAILABLE_SORTS: readonly ProjectsSort[] = [
  "last-opened",
  "name",
  "name-desc",
  "created",
  "modified",
  "deadline",
  "format",
];

export const LibraryViewControls: Component = () => {
  const [sortOpen, setSortOpen] = createSignal(false);
  let sortRef: HTMLDivElement | undefined;
  installDismiss(() => sortRef, sortOpen, () => setSortOpen(false));
  useListboxOpenFocus(sortOpen, () => sortRef);

  return (
    <div class="flex items-center gap-1.5">
      <div class="relative" ref={sortRef}>
        <button
          type="button"
          onClick={() => setSortOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={sortOpen()}
          class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-2 hover:bg-[var(--color-control-fill)]"
        >
          <span>
            Sort: <span class="text-fg-1">{SORT_LABEL[defaultSort()]}</span>
          </span>
          <ChevronDown size={10} style={{ opacity: 0.5 }} />
        </button>
        <Show when={sortOpen()}>
          <div
            role="listbox"
            tabindex={-1}
            onKeyDown={(e) =>
              handleListboxKeydown(e, sortRef, () => setSortOpen(false))
            }
            class="glass absolute right-0 top-full z-30 mt-1 w-[180px] rounded-lg"
            style={{ padding: "6px", background: "var(--color-popover-bg)" }}
          >
            <For each={AVAILABLE_SORTS}>
              {(key) => {
                const active = () => defaultSort() === key;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active()}
                    tabindex={-1}
                    onClick={() => {
                      setDefaultSort(key);
                      setSortOpen(false);
                    }}
                    class={`lift flex w-full items-center justify-between rounded-md px-2.5 text-left text-sm ${
                      active()
                        ? "bg-[var(--color-control-fill-hover)] text-fg-1"
                        : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                    }`}
                    style={{ height: "var(--ui-row-sm)" }}
                  >
                    <span>{SORT_LABEL[key]}</span>
                    <Show when={active()}>
                      <span
                        class="h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--color-accent-1)" }}
                      />
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <div class="glass-soft flex items-center gap-0.5 rounded-md p-0.5">
        <ViewToggleButton
          view="cards"
          active={defaultView() === "cards"}
          label="Cards"
          icon={<LayoutGrid size={12} />}
        />
        <ViewToggleButton
          view="list"
          active={defaultView() === "list"}
          label="List"
          icon={<List size={12} />}
        />
      </div>
    </div>
  );
};

const ViewToggleButton: Component<{
  view: ProjectsView;
  active: boolean;
  label: string;
  icon: JSX.Element;
}> = (props) => (
  <button
    type="button"
    onClick={() => setDefaultView(props.view)}
    aria-label={props.label}
    title={props.label}
    class={`flex h-7 w-7 items-center justify-center rounded ${
      props.active
        ? "bg-[var(--color-selection-bg)] text-fg-1"
        : "text-fg-2 hover:bg-[var(--color-control-fill)]"
    }`}
  >
    {props.icon}
  </button>
);

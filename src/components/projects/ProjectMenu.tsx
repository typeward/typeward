import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Copy,
  FolderInput,
  FolderOpen,
  Pencil,
  Tag,
  Trash2,
} from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Project } from "~/adapters/types";
import type { SpaceDef } from "~/ipc";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "~/components/primitives/ContextMenu";
import { describeIpcError } from "~/lib/errors";
import { notifyError } from "~/lib/toast";
import { setArchived, setSpace } from "~/stores/projects-store";
import { tintColor } from "./tints";

// Estimated dimensions used for submenu side selection.
const MENU_W = 224;
const SUBMENU_W = 190;

interface ProjectMenuProps {
  project: Project;
  x: number;
  y: number;
  spaces: SpaceDef[];
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  /** Permanent removal — opens the "Delete permanently" confirm (only offered
   *  from the trashed variant). */
  onDelete: () => void;
  onEditTags: () => void;
  /** Soft-trash the project (normal variant). Owner runs the setProject(null)
   *  engine-teardown guard when the trashed project is the one open. */
  onTrash: () => void;
  /** Restore from trash (trashed variant). */
  onRestore: () => void;
}

/**
 * Context menu for a project card/row, built on the shared `ContextMenu`
 * primitive. The "Move to space" nested inline column stays local (it's a
 * submenu, not a flat menuitem), as does its `SpaceItem`.
 */
export const ProjectMenu: Component<ProjectMenuProps> = (props) => {
  const [showSpaces, setShowSpaces] = createSignal(false);

  const submenuOnRight = createMemo(
    () => props.x + MENU_W + SUBMENU_W <= window.innerWidth - 8,
  );

  const run = async (verb: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notifyError(`Couldn't ${verb} project`, describeIpcError(e));
    }
    props.onClose();
  };

  const p = () => props.project;

  return (
    <ContextMenu x={props.x} y={props.y} onClose={props.onClose} widthPx={MENU_W}>
      <Show
        when={p().trashedAt != null}
        fallback={
          <>
            <ContextMenuItem icon={FolderOpen} label="Open" onClick={props.onOpen} />

            <div class="relative">
              <ContextMenuItem
                icon={FolderInput}
                label="Move to space"
                trailing={<ChevronRight size={12} style={{ opacity: 0.6 }} />}
                expanded={showSpaces()}
                onClick={() => setShowSpaces((v) => !v)}
              />
              <Show when={showSpaces()}>
                <div
                  role="menu"
                  class="glass absolute top-0 z-10 flex max-h-[240px] w-[190px] flex-col overflow-auto scroll rounded-lg"
                  style={{
                    padding: "5px",
                    background: "var(--color-popover-bg)",
                    ...(submenuOnRight()
                      ? { left: "calc(100% + 4px)" }
                      : { right: "calc(100% + 4px)" }),
                  }}
                >
                  <SpaceItem
                    label="None"
                    active={!p().space}
                    onClick={() => void run("move", () => setSpace(p().rootPath, null))}
                  />
                  <For each={props.spaces}>
                    {(s) => (
                      <SpaceItem
                        label={s.name}
                        dot={tintColor(s.tint)}
                        active={p().space === s.id}
                        onClick={() => void run("move", () => setSpace(p().rootPath, s.id))}
                      />
                    )}
                  </For>
                  <Show when={props.spaces.length === 0}>
                    <div class="px-2 py-1.5 text-xs text-fg-3">No spaces yet</div>
                  </Show>
                </div>
              </Show>
            </div>

            <ContextMenuItem icon={Tag} label="Edit tags…" onClick={props.onEditTags} />
            <ContextMenuItem icon={Pencil} label="Rename…" onClick={props.onRename} />
            <ContextMenuItem icon={Copy} label="Duplicate" onClick={props.onDuplicate} />
            <ContextMenuItem
              icon={p().archived ? ArchiveRestore : Archive}
              label={p().archived ? "Unarchive" : "Archive"}
              onClick={() =>
                void run(p().archived ? "unarchive" : "archive", () =>
                  setArchived(p().rootPath, !p().archived),
                )
              }
            />

            <ContextMenuSeparator />

            <ContextMenuItem
              icon={Trash2}
              label="Move to trash"
              danger
              onClick={props.onTrash}
            />
          </>
        }
      >
        <ContextMenuItem icon={ArchiveRestore} label="Restore" onClick={props.onRestore} />

        <ContextMenuSeparator />

        <ContextMenuItem
          icon={Trash2}
          label="Delete permanently…"
          danger
          onClick={props.onDelete}
        />
      </Show>
    </ContextMenu>
  );
};

const SpaceItem: Component<{
  label: string;
  dot?: string;
  active: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    role="menuitem"
    tabindex={-1}
    onClick={props.onClick}
    class="lift flex w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
    style={{ height: "var(--ui-row-sm)" }}
  >
    <Show
      when={props.dot}
      fallback={<span class="h-1.5 w-1.5 flex-shrink-0" />}
    >
      <span
        class="h-1.5 w-1.5 flex-shrink-0 rounded-full"
        style={{ background: props.dot }}
      />
    </Show>
    <span class="min-w-0 flex-1 truncate">{props.label}</span>
    <Show when={props.active}>
      <Check size={12} class="flex-shrink-0 text-[var(--color-accent-1)]" />
    </Show>
  </button>
);

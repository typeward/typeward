import { useNavigate } from "@solidjs/router";
import {
  Archive,
  Folder as FolderIcon,
  MoreHorizontal,
  Plus,
  Settings,
  Trash2,
  Upload,
  User,
  Users,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Project } from "~/adapters/types";
import type { SpaceDef } from "~/ipc";
import { TextField } from "~/components/forms/TextField";
import { KbdHint } from "~/components/primitives/KbdHint";
import { installDismiss } from "~/lib/dismiss";
import { setPreviousRoute } from "~/stores/nav-store";
import { isTrashed, isYours } from "~/stores/projects-store";
import { touchAffordances } from "~/stores/viewport-store";
import {
  SPACE_TINTS,
  type SpaceTint,
  coerceSpaceTint,
  enableSpaces,
  enableTags,
  setSpaces,
  spaces,
} from "~/stores/workspace-store";
import type { LibrarySelection } from "./library-selection";
import { sameSelection } from "./library-selection";
import { tagTint, tintColor } from "./tints";

interface LibrarySidebarProps {
  projects: Project[];
  selection: LibrarySelection;
  onSelect: (s: LibrarySelection) => void;
  onNewProject: () => void;
  onImport: () => void;
  /** Panel width — the tablet drawer stretches it to fill its shell. */
  width?: string;
}

export const LibrarySidebar: Component<LibrarySidebarProps> = (props) => {
  const navigate = useNavigate();

  const activeProjects = createMemo(() =>
    props.projects.filter((p) => !isTrashed(p) && !p.archived),
  );
  const yoursCount = createMemo(
    () => activeProjects().filter(isYours).length,
  );
  const archivedCount = createMemo(
    () => props.projects.filter((p) => !isTrashed(p) && p.archived).length,
  );
  const trashedCount = createMemo(
    () => props.projects.filter(isTrashed).length,
  );
  const spaceCounts = createMemo(() => {
    const m = new Map<string, number>();
    for (const p of activeProjects()) {
      if (p.space) m.set(p.space, (m.get(p.space) ?? 0) + 1);
    }
    return m;
  });
  const tagList = createMemo(() => {
    const m = new Map<string, number>();
    for (const p of activeProjects()) {
      for (const t of p.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return Array.from(m, ([tag, count]) => ({ tag, count })).sort(
      (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
    );
  });

  const isActive = (s: LibrarySelection) => sameSelection(props.selection, s);

  return (
    <div
      class="glass flex flex-col overflow-hidden rounded-xl"
      style={{ width: props.width ?? "240px", height: "100%" }}
    >
      <div class="border-b border-glass-stroke p-3">
        <button
          type="button"
          onClick={props.onNewProject}
          class="lift glow-accent relative flex h-9 w-full items-center justify-center gap-2 rounded-lg accent-grad text-sm font-semibold"
        >
          <Plus size={14} stroke-width={2.4} />
          <span>New project</span>
          <span class="ml-1">
            <KbdHint shortcut="Mod+N" size="md" tone="dark" />
          </span>
        </button>
        <div class="mt-2 grid grid-cols-1 gap-1.5">
          <button
            type="button"
            onClick={props.onImport}
            class="lift glass-soft flex items-center justify-center gap-1.5 rounded-md text-xs text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
            style={{ height: "var(--ui-row-sm)" }}
          >
            <Upload size={11} style={{ opacity: 0.7 }} />
            <span>Import folder</span>
          </button>
        </div>
      </div>

      <div class="flex-1 space-y-3.5 overflow-auto scroll p-2">
        <div>
          <GroupHeader label="Library" />
          <SidebarRow
            label="All projects"
            icon={FolderIcon}
            count={activeProjects().length}
            active={isActive({ kind: "all" })}
            onSelect={() => props.onSelect({ kind: "all" })}
          />
          <SidebarRow
            label="Your projects"
            icon={User}
            count={yoursCount()}
            active={isActive({ kind: "yours" })}
            onSelect={() => props.onSelect({ kind: "yours" })}
          />
          <SidebarRow
            label="Shared with you"
            icon={Users}
            count={0}
            active={isActive({ kind: "shared" })}
            onSelect={() => props.onSelect({ kind: "shared" })}
          />
          <SidebarRow
            label="Archived projects"
            icon={Archive}
            count={archivedCount()}
            active={isActive({ kind: "archive" })}
            onSelect={() => props.onSelect({ kind: "archive" })}
          />
          <SidebarRow
            label="Trashed projects"
            icon={Trash2}
            count={trashedCount()}
            active={isActive({ kind: "trash" })}
            onSelect={() => props.onSelect({ kind: "trash" })}
          />
        </div>

        <Show when={enableSpaces()}>
          <div>
            <GroupHeader label="Spaces" action={<AddSpaceButton />} />
            <Show
              when={spaces().length > 0}
              fallback={<EmptyHint text="No spaces yet. Add one with +." />}
            >
              <For each={spaces()}>
                {(space) => (
                  <SpaceRow
                    space={space}
                    count={spaceCounts().get(space.id) ?? 0}
                    active={isActive({ kind: "space", id: space.id })}
                    onSelect={() =>
                      props.onSelect({ kind: "space", id: space.id })
                    }
                  />
                )}
              </For>
            </Show>
          </div>
        </Show>

        <Show when={enableTags()}>
          <div>
            <GroupHeader label="Tags" />
            <Show
              when={tagList().length > 0}
              fallback={<EmptyHint text="Tags you add to projects appear here." />}
            >
              <For each={tagList()}>
                {(entry) => (
                  <SidebarRow
                    label={entry.tag}
                    dot={tagTint(entry.tag)}
                    count={entry.count}
                    active={isActive({ kind: "tag", tag: entry.tag })}
                    onSelect={() =>
                      props.onSelect({ kind: "tag", tag: entry.tag })
                    }
                  />
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>

      <div class="border-t border-glass-stroke p-3">
        <button
          type="button"
          onClick={() => {
            setPreviousRoute("/projects");
            navigate("/settings");
          }}
          class="lift glass-soft flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-xs text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
        >
          <Settings size={11} style={{ opacity: 0.7 }} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
};

const GroupHeader: Component<{ label: string; action?: JSX.Element }> = (
  props,
) => (
  <div class="label-xs mb-1.5 flex items-center justify-between px-2 text-fg-3">
    <span>{props.label}</span>
    {props.action}
  </div>
);

const EmptyHint: Component<{ text: string }> = (props) => (
  <div class="px-2 py-1 text-xs text-fg-3">{props.text}</div>
);

const SidebarRow: Component<{
  label: string;
  icon?: Component<{ size?: number; class?: string }>;
  dot?: string;
  count?: number;
  active: boolean;
  onSelect: () => void;
  trailing?: JSX.Element;
}> = (props) => (
  <div class="group/row relative flex items-center">
    <button
      type="button"
      onClick={props.onSelect}
      class={`lift relative flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-base ${
        props.active
          ? "side-active bg-[var(--color-selection-bg)] text-fg-1"
          : "text-fg-2 hover:bg-[var(--color-control-fill)]"
      }`}
      // max() keeps comfortable density's taller rows while guaranteeing the
      // 44px WCAG target on coarse pointers; keyed on touchAffordances(), not
      // the viewport width, so narrow mouse-driven windows are unaffected.
      style={{
        height: touchAffordances()
          ? "max(44px, var(--ui-row))"
          : "var(--ui-row)",
      }}
    >
      <Show
        when={props.dot}
        fallback={props.icon ? <props.icon size={14} class="flex-shrink-0" /> : null}
      >
        <span
          class="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: props.dot }}
        />
      </Show>
      <span class={`min-w-0 truncate ${props.active ? "font-medium" : ""}`}>
        {props.label}
      </span>
      <Show when={props.count != null}>
        <span
          class={`mono ml-auto text-xs text-fg-3 ${
            props.trailing ? "transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0" : ""
          }`}
        >
          {props.count}
        </span>
      </Show>
    </button>
    {props.trailing}
  </div>
);

const AddSpaceButton: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [tint, setTint] = createSignal<SpaceTint>("accent");
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  const submit = () => {
    const n = name().trim();
    if (!n) return;
    setSpaces([...spaces(), { id: crypto.randomUUID(), name: n, tint: tint() }]);
    setName("");
    setTint("accent");
    setOpen(false);
  };

  return (
    <div class="relative" ref={rootRef}>
      <button
        type="button"
        aria-label="Add space"
        onClick={() => {
          setName("");
          setTint("accent");
          setOpen((v) => !v);
        }}
        class="lift -m-0.5 -mr-1.5 flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
      >
        <Plus size={12} />
      </button>
      <Show when={open()}>
        <div
          class="glass absolute right-0 top-full z-40 mt-1 flex w-[210px] flex-col gap-2 rounded-lg"
          style={{
            padding: "var(--ui-pad-section)",
            background: "var(--color-popover-bg)",
          }}
        >
          <span class="label-xs text-fg-3">New space</span>
          <TextField
            label="Space name"
            hideLabel
            size="sm"
            type="text"
            value={name()}
            placeholder="Space name"
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            /* eslint-disable-next-line jsx-a11y/no-autofocus */
            autofocus
          />
          <TintSwatches value={tint()} onChange={setTint} />
          <div class="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              class="rounded px-2 py-1 text-xs text-fg-3 hover:text-fg-1"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!name().trim()}
              class="lift rounded-md accent-grad px-2.5 py-1 text-xs font-medium disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};

const SpaceRow: Component<{
  space: SpaceDef;
  count: number;
  active: boolean;
  onSelect: () => void;
}> = (props) => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [name, setName] = createSignal(props.space.name);
  const [tint, setTint] = createSignal<SpaceTint>(
    coerceSpaceTint(props.space.tint),
  );
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, menuOpen, () => setMenuOpen(false));

  const openMenu = () => {
    setName(props.space.name);
    setTint(coerceSpaceTint(props.space.tint));
    setMenuOpen(true);
  };

  const save = () => {
    const n = name().trim();
    if (!n) return;
    setSpaces(
      spaces().map((s) =>
        s.id === props.space.id ? { ...s, name: n, tint: tint() } : s,
      ),
    );
    setMenuOpen(false);
  };

  const del = () => {
    setSpaces(spaces().filter((s) => s.id !== props.space.id));
    setMenuOpen(false);
  };

  return (
    <div class="relative" ref={rootRef}>
      <SidebarRow
        label={props.space.name}
        dot={tintColor(props.space.tint)}
        count={props.count}
        active={props.active}
        onSelect={props.onSelect}
        trailing={
          <button
            type="button"
            aria-label={`Space options for ${props.space.name}`}
            onClick={(e) => {
              e.stopPropagation();
              menuOpen() ? setMenuOpen(false) : openMenu();
            }}
            class="lift absolute right-0.5 -mt-0.5 flex h-6 w-6 items-center justify-center rounded text-fg-3 opacity-0 hover:bg-[var(--color-control-fill)] hover:text-fg-1 group-hover/row:opacity-100 focus-visible:opacity-100 group-focus-within/row:opacity-100"
          >
            <MoreHorizontal size={13} />
          </button>
        }
      />
      <Show when={menuOpen()}>
        <div
          class="glass absolute right-0 top-full z-40 mt-1 flex w-[210px] flex-col gap-2 rounded-lg"
          style={{
            padding: "var(--ui-pad-section)",
            background: "var(--color-popover-bg)",
          }}
        >
          <span class="label-xs text-fg-3">Edit space</span>
          <TextField
            label="Space name"
            hideLabel
            size="sm"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setMenuOpen(false);
              }
            }}
          />
          <TintSwatches value={tint()} onChange={setTint} />
          <div class="flex items-center justify-between gap-1.5">
            <button
              type="button"
              onClick={del}
              class="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-fg-3 hover:text-[var(--color-err)]"
            >
              <Trash2 size={11} />
              Delete
            </button>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                class="rounded px-2 py-1 text-xs text-fg-3 hover:text-fg-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!name().trim()}
                class="lift rounded-md accent-grad px-2.5 py-1 text-xs font-medium disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

const TintSwatches: Component<{
  value: string;
  onChange: (t: SpaceTint) => void;
}> = (props) => (
  <div class="flex flex-wrap gap-1.5">
    <For each={SPACE_TINTS}>
      {(t) => (
        <button
          type="button"
          aria-label={`Color ${t}`}
          onClick={() => props.onChange(t)}
          // The 24px hit box wraps a 20px visual swatch so the circles keep
          // their size while the target meets WCAG 2.5.8.
          class="flex h-6 w-6 items-center justify-center rounded-full"
        >
          <span
            class="h-5 w-5 rounded-full"
            style={{
              background: tintColor(t),
              "box-shadow":
                props.value === t
                  ? "0 0 0 2px var(--color-popover-bg), 0 0 0 3.5px var(--color-fg-1)"
                  : "none",
            }}
          />
        </button>
      )}
    </For>
  </div>
);

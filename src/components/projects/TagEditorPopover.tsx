import { Plus, X } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { Project } from "~/adapters/types";
import { describeIpcError } from "~/lib/errors";
import { installDismiss } from "~/lib/dismiss";
import { notifyError } from "~/lib/toast";
import { setTags } from "~/stores/projects-store";
import { tagTint } from "./tints";

const POPOVER_W = 240;

interface TagEditorPopoverProps {
  project: Project;
  x: number;
  y: number;
  /** Known-tag union across the library, for suggestions. */
  suggestions: string[];
  onClose: () => void;
}

/**
 * Tag editor popover: current tags as removable chips + an Enter-commit input +
 * a filtered suggestion list. Local state drives the chips for instant feedback;
 * every mutation persists through `setTags` (optimistic in the store too).
 */
export const TagEditorPopover: Component<TagEditorPopoverProps> = (props) => {
  const [tags, setLocalTags] = createSignal<string[]>([
    ...(props.project.tags ?? []),
  ]);
  const [draft, setDraft] = createSignal("");
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  let rootRef: HTMLDivElement | undefined;

  installDismiss(() => rootRef, () => true, () => props.onClose());

  onMount(() => {
    const el = rootRef;
    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 8;
      let x = props.x;
      let y = props.y;
      if (x + r.width > window.innerWidth - pad)
        x = Math.max(pad, window.innerWidth - r.width - pad);
      if (y + r.height > window.innerHeight - pad)
        y = Math.max(pad, window.innerHeight - r.height - pad);
      if (x !== props.x || y !== props.y) setPos({ x, y });
      el.querySelector("input")?.focus();
    }
    const onScroll = () => props.onClose();
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => window.removeEventListener("scroll", onScroll, true));
  });

  const commit = (next: string[]) => {
    setLocalTags(next);
    void setTags(props.project.rootPath, next).catch((e) =>
      notifyError(describeIpcError(e)),
    );
  };

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    const exists = tags().some((t) => t.toLowerCase() === tag.toLowerCase());
    if (exists) {
      setDraft("");
      return;
    }
    commit([...tags(), tag]);
    setDraft("");
  };

  const removeTag = (tag: string) => {
    commit(tags().filter((t) => t !== tag));
  };

  const filteredSuggestions = createMemo(() => {
    const q = draft().trim().toLowerCase();
    const current = new Set(tags().map((t) => t.toLowerCase()));
    return props.suggestions
      .filter((s) => !current.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 8);
  });

  return (
    <Portal>
    <div
      ref={rootRef}
      class="glass fixed z-50 flex flex-col gap-2 rounded-lg"
      style={{
        left: `${pos().x}px`,
        top: `${pos().y}px`,
        width: `${POPOVER_W}px`,
        padding: "var(--ui-pad-section)",
        background: "var(--color-popover-bg)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span class="label-xs text-fg-3">Tags · {props.project.name}</span>

      <Show
        when={tags().length > 0}
        fallback={<span class="text-xs text-fg-3">No tags yet.</span>}
      >
        <div class="flex flex-wrap gap-1">
          <For each={tags()}>
            {(tag) => (
              <span
                class="mono flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-fg-2"
                style={{ background: "var(--color-control-fill)" }}
              >
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  style={{ background: tagTint(tag) }}
                />
                <span class="max-w-[120px] truncate">{tag}</span>
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  aria-label={`Remove tag ${tag}`}
                  class="-mr-0.5 flex h-3.5 w-3.5 items-center justify-center rounded text-fg-3 hover:text-[var(--color-err)]"
                >
                  <X size={9} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="flex items-center gap-1.5">
        <input
          type="text"
          value={draft()}
          placeholder="Add a tag…"
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              addTag(draft());
            } else if (e.key === "Escape") {
              e.stopPropagation();
              props.onClose();
            }
          }}
          class="glass-inset min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
        />
        <button
          type="button"
          onClick={() => addTag(draft())}
          disabled={!draft().trim()}
          aria-label="Add tag"
          class="lift flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-[var(--color-control-fill)] disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
      </div>

      <Show when={filteredSuggestions().length > 0}>
        <div class="flex flex-col gap-0.5">
          <span class="label-xs text-fg-3">Suggestions</span>
          <div class="flex flex-wrap gap-1">
            <For each={filteredSuggestions()}>
              {(s) => (
                <button
                  type="button"
                  onClick={() => addTag(s)}
                  class="mono flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    style={{ background: tagTint(s) }}
                  />
                  <span class="max-w-[120px] truncate">{s}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
    </Portal>
  );
};

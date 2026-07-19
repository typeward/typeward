import type { Component, JSX } from "solid-js";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type * as ipc from "~/ipc";
import type { CommentThread } from "~/lib/reviews/types";
import { ThreadCard } from "~/components/reviews/ThreadCard";
import { activeFile, requestGotoSource } from "~/stores/editor-store";
import { offsetToLine } from "~/lib/reviews/lines";
import { scannedTodos } from "~/stores/todo-store";
import {
  allThreads,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  focusedThreadId,
  clearFocusedThread,
} from "~/stores/review-store";

/**
 * Two-source model: TODO-kind review threads (kind === "todo", typically
 * created from a PDF selection) list first, then the scanned source markers.
 */
export type TodoEntry =
  | { source: "scan"; item: ipc.TodoItem }
  | { source: "thread"; thread: CommentThread };

const KIND_STYLE: Record<string, { label: string; color: string }> = {
  todo: { label: "TODO", color: "var(--color-warn)" },
  fixme: { label: "FIXME", color: "var(--color-err)" },
  note: { label: "NOTE", color: "var(--color-fg-3)" },
};

export const TodoPanel: Component = () => {
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [showResolved, setShowResolved] = createSignal(false);

  const todoThreads = createMemo<CommentThread[]>(() =>
    allThreads().filter((t) => (t.kind ?? "comment") === "todo"),
  );

  const entries = createMemo<TodoEntry[]>(() => [
    ...todoThreads()
      .filter((t) => showResolved() || t.status === "open")
      .map((thread) => ({ source: "thread", thread }) as const),
    ...scannedTodos().map((item) => ({ source: "scan", item }) as const),
  ]);

  // Line number is only resolvable for threads anchored in the open buffer
  // (offsets align with its content). Cross-file threads still jump; the panel
  // just omits the number.
  const lineNumberFor = (thread: CommentThread): number | null => {
    const f = activeFile();
    if (!f || f.relPath !== thread.fileRelPath) return null;
    if (thread.fromOffset < 0 || thread.fromOffset > f.content.length) return null;
    return offsetToLine(f.content, thread.fromOffset);
  };

  const jumpToThread = (thread: CommentThread) => {
    requestGotoSource(thread.fileRelPath, lineNumberFor(thread) ?? 1, {
      from: thread.fromOffset,
      to: thread.toOffset,
    });
  };

  const renderThread = (thread: CommentThread): JSX.Element => (
    <div data-thread-id={thread.id}>
      <ThreadCard
        thread={thread}
        expanded={expandedId() === thread.id}
        orphaned={false}
        lineNumber={lineNumberFor(thread)}
        onToggle={() =>
          setExpandedId((prev) => (prev === thread.id ? null : thread.id))
        }
        onClickAnchor={() => jumpToThread(thread)}
        onReply={(body) => addReplyToThread(thread.id, "You", body)}
        onResolve={() => resolveThreadById(thread.id)}
        onReopen={() => reopenThreadById(thread.id)}
        onDelete={() => removeThread(thread.id)}
        onReanchor={() => {}}
      />
    </div>
  );

  const renderScan = (item: ipc.TodoItem): JSX.Element => {
    const style = KIND_STYLE[item.kind] ?? KIND_STYLE.note;
    return (
      <div class="px-2 py-0.5">
        <button
          type="button"
          onClick={() => requestGotoSource(item.file, item.line)}
          class="lift flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-control-fill)]"
        >
          <span
            class="mono mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
            style={{
              color: style.color,
              background: "color-mix(in srgb, currentColor 14%, transparent)",
            }}
          >
            {style.label}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-fg-1">
              {item.text || <span class="text-fg-3 italic">(no text)</span>}
            </span>
            <span class="mono block truncate text-[10px] text-fg-3">
              {item.file}:{item.line}
            </span>
          </span>
        </button>
      </div>
    );
  };

  let listRef: HTMLDivElement | undefined;
  // A PDF-created TODO opens targeted: expand it and scroll it into view.
  createEffect(() => {
    const id = focusedThreadId();
    if (!id) return;
    const thread = todoThreads().find((t) => t.id === id);
    if (!thread) {
      clearFocusedThread();
      return;
    }
    if (thread.status === "resolved" && !showResolved()) setShowResolved(true);
    setExpandedId(id);
    requestAnimationFrame(() => {
      listRef
        ?.querySelector(`[data-thread-id="${id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    clearFocusedThread();
  });

  return (
    <Show
      when={entries().length > 0}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-base font-semibold text-fg-1">No TODOs found</div>
          <div class="text-xs leading-relaxed text-fg-3">
            Markers like <span class="mono">% TODO</span>,{" "}
            <span class="mono">// FIXME</span>, and{" "}
            <span class="mono">NOTE</span> in your sources, plus TODOs you add from
            the editor or PDF, show up here.
          </div>
        </div>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col">
        <Show when={todoThreads().some((t) => t.status === "resolved")}>
          <div class="flex items-center justify-end border-b border-[var(--color-border)] px-3 py-1.5">
            <label class="-m-1.5 flex items-center gap-1.5 p-1.5 text-[10px] text-fg-3 select-none">
              <input
                type="checkbox"
                checked={showResolved()}
                onChange={(e) => setShowResolved(e.currentTarget.checked)}
                class="h-3 w-3 rounded accent-[var(--color-accent-1)]"
              />
              Resolved
            </label>
          </div>
        </Show>
        <div ref={listRef} class="min-h-0 flex-1 overflow-auto scroll py-1.5">
          <For each={entries()}>
          {(entry) =>
            entry.source === "thread"
              ? renderThread(entry.thread)
              : renderScan(entry.item)
          }
          </For>
        </div>
      </div>
    </Show>
  );
};

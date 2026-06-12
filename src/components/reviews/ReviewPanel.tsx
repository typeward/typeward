import { Inbox } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";

import { ThreadCard } from "./ThreadCard";
import { activeFile } from "~/stores/editor-store";
import {
  allThreads,
  showResolved,
  setShowResolved,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
} from "~/stores/review-store";
import { recoverThreads } from "~/lib/reviews/recovery";
import { setCursorLine } from "~/stores/editor-view-store";

export type ReviewScope = "file" | "all";

export interface ReviewPanelProps {
  onRequestReanchor?: (threadId: string) => void;
}

export const ReviewPanel: Component<ReviewPanelProps> = (props) => {
  const [scope, setScope] = createSignal<ReviewScope>("file");
  const [expandedId, setExpandedId] = createSignal<string | null>(null);

  const file = activeFile;

  const threads = createMemo(() => {
    const all = allThreads();
    const show = showResolved();
    let filtered =
      scope() === "file" && file()
        ? all.filter((t) => t.fileRelPath === file()!.relPath)
        : all;
    if (!show) {
      filtered = filtered.filter((t) => t.status === "open");
    }
    return filtered;
  });

  const orphanedIds = createMemo(() => {
    const f = file();
    if (!f) return new Set<string>();
    const recovered = recoverThreads(allThreads(), f.content, f.relPath);
    return new Set(
      recovered.filter((r) => r.recoveryStatus === "orphaned").map((r) => r.thread.id),
    );
  });

  const lineNumberFor = (thread: { fromOffset: number }): number | null => {
    const f = file();
    if (!f) return null;
    const offset = thread.fromOffset;
    if (offset < 0 || offset > f.content.length) return null;
    const before = f.content.slice(0, offset);
    return before.split("\n").length;
  };

  const handleClickAnchor = (thread: { fromOffset: number }) => {
    const line = lineNumberFor(thread);
    if (line !== null) {
      setCursorLine(line);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-shrink-0 items-center justify-between border-b border-glass-stroke px-3 py-2">
        <div class="flex items-center gap-1 rounded-md p-0.5" style={{ background: "var(--color-control-fill)" }}>
          <button
            type="button"
            onClick={() => setScope("file")}
            class={`rounded px-2 py-0.5 text-[11px] font-medium ${scope() === "file" ? "text-fg-1" : "text-fg-3 hover:text-fg-2"}`}
            style={scope() === "file" ? { background: "var(--color-control-fill-hover)" } : {}}
          >
            This file
          </button>
          <button
            type="button"
            onClick={() => setScope("all")}
            class={`rounded px-2 py-0.5 text-[11px] font-medium ${scope() === "all" ? "text-fg-1" : "text-fg-3 hover:text-fg-2"}`}
            style={scope() === "all" ? { background: "var(--color-control-fill-hover)" } : {}}
          >
            All files
          </button>
        </div>
        <label class="flex items-center gap-1.5 text-[10px] text-fg-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showResolved()}
            onChange={(e) => setShowResolved(e.currentTarget.checked)}
            class="h-3 w-3 rounded accent-[var(--color-accent-1)]"
          />
          Resolved
        </label>
      </div>

      <div class="min-h-0 flex-1 overflow-auto scroll py-1.5">
        <Show
          when={threads().length > 0}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-full"
                style={{ background: "var(--color-control-fill)" }}
              >
                <Inbox size={20} />
              </div>
              <div class="text-[13px] font-semibold text-fg-1">No review threads</div>
              <div class="text-[11px] leading-relaxed text-fg-3">
                Select text and press Ctrl+Shift+M to start a review thread.
              </div>
            </div>
          }
        >
          <For each={threads()}>
            {(thread) => (
              <ThreadCard
                thread={thread}
                expanded={expandedId() === thread.id}
                orphaned={orphanedIds().has(thread.id)}
                lineNumber={lineNumberFor(thread)}
                onToggle={() => toggleExpanded(thread.id)}
                onClickAnchor={() => handleClickAnchor(thread)}
                onReply={(body) => addReplyToThread(thread.id, "You", body)}
                onResolve={() => resolveThreadById(thread.id)}
                onReopen={() => reopenThreadById(thread.id)}
                onDelete={() => removeThread(thread.id)}
                onReanchor={() => props.onRequestReanchor?.(thread.id)}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

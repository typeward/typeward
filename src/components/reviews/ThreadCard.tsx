import { Check, ChevronDown, ChevronUp, MessageCircle, AlertTriangle, Trash2, RotateCcw, Crosshair } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import type { CommentThread } from "~/lib/reviews/types";

export interface ThreadCardProps {
  thread: CommentThread;
  expanded: boolean;
  orphaned: boolean;
  lineNumber: number | null;
  onToggle: () => void;
  onClickAnchor: () => void;
  onReply: (body: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onReanchor: () => void;
}

export const ThreadCard: Component<ThreadCardProps> = (props) => {
  const [replyText, setReplyText] = createSignal("");

  const rootComment = () => props.thread.comments[0];
  const replies = () => props.thread.comments.slice(1);
  const isResolved = () => props.thread.status === "resolved";

  const handleReply = () => {
    const text = replyText().trim();
    if (!text) return;
    props.onReply(text);
    setReplyText("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleReply();
    }
  };

  const relativeTime = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  return (
    <div
      class="border-l-2 rounded-lg mx-2 mb-1.5"
      style={{
        "border-color": props.orphaned
          ? "var(--color-warn)"
          : isResolved()
            ? "var(--color-fg-3)"
            : "var(--color-accent-1)",
        background: "var(--color-control-fill)",
      }}
    >
      <button
        type="button"
        onClick={props.onToggle}
        class="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-[var(--color-control-fill)]"
      >
        <div class="min-w-0 flex-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              props.onClickAnchor();
            }}
            class="mono block max-w-full truncate text-[11px] text-fg-2 hover:text-[var(--color-accent-1)]"
            title="Jump to anchor in editor"
          >
            {props.orphaned ? `(anchor lost) ${props.thread.anchorText}` : `"${props.thread.anchorText}"`}
          </button>

          <div class="mt-0.5 text-[10px] text-fg-3">
            {props.thread.fileRelPath}
            <Show when={props.lineNumber !== null}>:{props.lineNumber}</Show>
          </div>

          <div class="mt-1 text-[12px] text-fg-2">
            <span class="font-medium text-fg-1">{rootComment()?.author}</span>
            <span class="text-fg-3"> · {relativeTime(rootComment()?.createdAt ?? "")}</span>
          </div>
          <div class="mt-0.5 text-[12px] text-fg-2 leading-relaxed">
            {rootComment()?.body}
          </div>

          <Show when={!props.expanded}>
            <div class="mt-1 flex items-center gap-2 text-[10px] text-fg-3">
              <Show when={replies().length > 0}>
                <span class="flex items-center gap-0.5">
                  <MessageCircle size={10} />
                  {replies().length} {replies().length === 1 ? "reply" : "replies"}
                </span>
              </Show>
              <Show when={props.orphaned}>
                <span class="flex items-center gap-0.5 text-[var(--color-warn)]">
                  <AlertTriangle size={10} />
                  orphaned
                </span>
              </Show>
            </div>
          </Show>
        </div>

        <div class="flex-shrink-0 pt-0.5">
          <Show when={props.expanded} fallback={<ChevronDown size={12} class="text-fg-3" />}>
            <ChevronUp size={12} class="text-fg-3" />
          </Show>
        </div>
      </button>

      <Show when={props.expanded}>
        <div class="border-t border-glass-stroke px-2.5 pb-2.5">
          <Show when={replies().length > 0}>
            <div class="mt-2 space-y-2">
              <For each={replies()}>
                {(reply) => (
                  <div class="rounded-md px-2 py-1.5" style={{ background: "rgba(255,255,255,0.03)" }}>
                    <div class="text-[11px]">
                      <span class="font-medium text-fg-1">{reply.author}</span>
                      <span class="text-fg-3"> · {relativeTime(reply.createdAt)}</span>
                    </div>
                    <div class="mt-0.5 text-[12px] text-fg-2 leading-relaxed">{reply.body}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="mt-2">
            <textarea
              value={replyText()}
              onInput={(e) => setReplyText(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply... (Ctrl+Enter to send)"
              class="w-full resize-none rounded-md border border-glass-stroke bg-transparent px-2 py-1.5 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-[var(--color-accent-1)] focus:outline-none"
              rows={2}
            />
            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleReply}
                disabled={!replyText().trim()}
                class="rounded-md px-2.5 py-1 text-[11px] font-medium disabled:opacity-40"
                style={{ background: "var(--color-accent-1)", color: "#fff" }}
              >
                Reply
              </button>

              <Show when={isResolved()}>
                <button
                  type="button"
                  onClick={props.onReopen}
                  class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-3 hover:text-fg-1"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <RotateCcw size={10} /> Reopen
                </button>
              </Show>
              <Show when={!isResolved()}>
                <button
                  type="button"
                  onClick={props.onResolve}
                  class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-3 hover:text-fg-1"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <Check size={10} /> Resolve
                </button>
              </Show>

              <Show when={props.orphaned}>
                <button
                  type="button"
                  onClick={props.onReanchor}
                  class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-warn)] hover:text-fg-1"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <Crosshair size={10} /> Re-anchor
                </button>
              </Show>

              <button
                type="button"
                onClick={props.onDelete}
                class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-3 hover:text-[var(--color-err)]"
              >
                <Trash2 size={10} />
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Check,
  ChevronDown,
  Copy,
  History,
  ImagePlus,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Sparkles,
  SquarePen,
  Square,
  Trash2,
  X,
} from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";

import {
  activeProvider,
  activeProviderId,
} from "~/integrations/ai/registry";
import { applyChatTextToSelection } from "~/integrations/ai/actions";
import {
  MAX_IMAGES_PER_MESSAGE,
  formatBytes,
  normalizeImage,
} from "~/integrations/ai/attachments";
import { modelSupportsImages } from "~/integrations/ai/capabilities";
import { extractInsertText } from "~/integrations/ai/chat-text";
import type { ChatAttachment } from "~/integrations/types";
import { describeIpcError } from "~/lib/errors";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { notifyError, notifyInfo } from "~/lib/toast";
import {
  decorateCodeBlocks,
  renderAssistantMarkdown,
} from "~/components/editor/ai-markdown";
import {
  type ChatTurn,
  type Conversation,
  activeConversation,
  activeConversationId,
  chatDraft,
  chatError,
  chatStreaming,
  chatStreamingText,
  conversations,
  deleteConversation,
  ensureConversationsLoaded,
  newConversation,
  pendingAttachments,
  regenerateLastTurn,
  selectConversation,
  sendChatMessage,
  setChatDraft,
  setPendingAttachments,
  stopChatStream,
  streamingConversationId,
} from "~/stores/ai-chat-store";
import { cursorCol, cursorLine, getActiveEditorView, insertAtCursor } from "~/stores/editor-view-store";
import { integrationsSettings, setIntegrationsSettings } from "~/stores/settings-store";

/**
 * AI chat panel — render-only over `ai-chat-store` (streaming, stop /
 * regenerate, and JSONL persistence live in the store, so a pane switch no
 * longer kills a generation). Assistant bubbles render sanitized markdown;
 * each carries Copy / Insert-at-cursor / Apply-to-selection, and the last
 * one Regenerate. Conversations persist per project and are listed in the
 * header switcher.
 */
export const AiView: Component = () => {
  const [modelsError, setModelsError] = createSignal(false);
  let scrollEl: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;

  onMount(() => {
    void ensureConversationsLoaded().then(() => {
      if (!activeConversationId() && conversations().length > 0) {
        selectConversation(conversations()[0].id);
      }
    });
  });

  const provider = () => activeProvider(integrationsSettings().ai.ollamaBaseUrl);

  // Seq token: a superseded fetch's late rejection must not flag an error
  // over a newer successful one (resource return values are staleness-safe,
  // signal side effects are not).
  let modelsSeq = 0;
  const [models] = createResource(
    () => [activeProviderId(), integrationsSettings().ai.ollamaBaseUrl] as const,
    async ([id]) => {
      const seq = ++modelsSeq;
      if (!id) {
        if (seq === modelsSeq) setModelsError(false);
        return [];
      }
      try {
        const list = (await provider()?.models()) ?? [];
        if (seq === modelsSeq) setModelsError(false);
        return list;
      } catch {
        if (seq === modelsSeq) setModelsError(true);
        return [];
      }
    },
    { initialValue: [] },
  );

  const selectedModel = () => {
    const id = activeProviderId();
    if (!id) return "";
    const stored = integrationsSettings().ai.perProviderModel[id];
    if (stored) return stored;
    const first = models()?.[0]?.id;
    return first ?? "";
  };

  const setSelectedModel = (modelId: string) => {
    const id = activeProviderId();
    if (!id) return;
    setIntegrationsSettings({
      ...integrationsSettings(),
      ai: {
        ...integrationsSettings().ai,
        perProviderModel: {
          ...integrationsSettings().ai.perProviderModel,
          [id]: modelId,
        },
      },
    });
  };

  // Attach UI is visible only when the selected model takes images —
  // capability matrix for the cloud providers, live /api/show probe for
  // Ollama (default closed either way).
  const [supportsImages] = createResource(
    () =>
      [
        activeProviderId(),
        selectedModel(),
        integrationsSettings().ai.ollamaBaseUrl,
      ] as const,
    async ([id, model, base]) => {
      if (!id || !model) return false;
      try {
        return await modelSupportsImages(id, model, base);
      } catch {
        return false;
      }
    },
    { initialValue: false },
  );

  const addImages = async (blobs: Array<{ blob: Blob; name?: string }>) => {
    if (!supportsImages()) {
      notifyInfo("This model doesn't accept images");
      return;
    }
    for (const { blob, name } of blobs) {
      if (pendingAttachments().length >= MAX_IMAGES_PER_MESSAGE) {
        notifyInfo(`At most ${MAX_IMAGES_PER_MESSAGE} images per message`);
        return;
      }
      const result = await normalizeImage(blob, name);
      if (result.ok) {
        setPendingAttachments((prev) => [...prev, result.attachment]);
      } else {
        notifyError("Image not attached", result.reason);
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items.filter((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    const blobs = images
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null)
      .map((f) => ({ blob: f as Blob, name: f.name || undefined }));
    void addImages(blobs);
  };

  const onPickFiles = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []).map((f) => ({
      blob: f as Blob,
      name: f.name,
    }));
    input.value = "";
    void addImages(files);
  };

  const send = () => {
    if (chatStreaming() || !activeProviderId()) return;
    const text = chatDraft();
    if (!text.trim()) return;
    const attachments = pendingAttachments();
    setChatDraft("");
    setPendingAttachments([]);
    void sendChatMessage(text, attachments);
  };

  const turns = createMemo<ChatTurn[]>(() => activeConversation()?.turns ?? []);
  const showStreamingBubble = () =>
    chatStreaming() && streamingConversationId() === activeConversationId();
  const empty = createMemo(() => turns().length === 0 && !showStreamingBubble());

  // Jump to the latest turn when switching conversations…
  createEffect(() => {
    activeConversationId();
    queueMicrotask(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  });
  // …and follow the stream while it grows, unless the user scrolled up.
  createEffect(() => {
    turns();
    chatStreamingText();
    if (!scrollEl) return;
    const nearBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 160;
    if (nearBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  // Selection changes move the cursor, so the cursor signals double as a
  // cheap "has selection" tick for the Apply-to-selection buttons.
  const hasEditorSelection = createMemo(() => {
    cursorLine();
    cursorCol();
    const view = getActiveEditorView();
    const sel = view?.state.selection.main;
    return !!sel && sel.from !== sel.to;
  });

  return (
    <div class="flex h-full flex-col" style={{ background: "var(--color-overlay-dim)" }}>
      <AiHeader
        providerId={activeProviderId()}
        model={selectedModel()}
        models={models() ?? []}
        modelsError={modelsError()}
        onModelChange={setSelectedModel}
      />

      <div ref={scrollEl} class="flex-1 overflow-auto scroll px-4 py-4">
        <Show
          when={!empty()}
          fallback={
            <div class="mx-auto flex max-w-[520px] flex-col items-center gap-3 pt-12 text-center">
              <span
                class="flex h-12 w-12 items-center justify-center rounded-2xl accent-grad"
                style={{ "box-shadow": "0 0 0 1px color-mix(in srgb, var(--color-accent-1) 35%, transparent)" }}
              >
                <Sparkles size={20} />
              </span>
              <h2 class="text-lg font-semibold text-fg-1">
                {activeProviderId() ? "Ask anything" : "No AI provider configured"}
              </h2>
              <p class="text-sm leading-relaxed text-fg-3">
                <Show
                  when={activeProviderId()}
                  fallback={
                    <span>
                      Pick a provider in Settings → Integrations → AI and mark
                      it active. A local Ollama daemon works fully offline.
                    </span>
                  }
                >
                  <span>
                    Conversations stay on this machine, saved with the
                    project. Select text in the editor and right-click for
                    Rewrite, Explain, and the other AI actions.
                  </span>
                </Show>
              </p>
            </div>
          }
        >
          <div class="flex flex-col gap-3">
            {/* Live region covers completed turns only — the streaming bubble
                mutates on every delta and would announce noise. */}
            <div aria-live="polite" class="flex flex-col gap-3 empty:hidden">
              <For each={turns()}>
                {(turn, i) => (
                  <MessageBubble
                    turn={turn}
                    isLastAssistant={
                      turn.role === "assistant" && i() === turns().length - 1
                    }
                    hasSelection={hasEditorSelection()}
                  />
                )}
              </For>
            </div>
            <Show when={showStreamingBubble()}>
              <div class="flex justify-start">
                <div
                  class="max-w-[80%] select-text rounded-lg px-3 py-2 text-sm leading-relaxed glass-soft text-fg-1"
                  style={{ "white-space": "pre-wrap" }}
                >
                  {chatStreamingText() || "…"}
                  <span class="caret" />
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={chatError()}>
        <div
          role="alert"
          class="mx-2.5 mb-2 select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]"
        >
          {chatError()}
        </div>
      </Show>

      <div class="flex-shrink-0 border-t border-glass-stroke p-2.5">
        <Show when={pendingAttachments().length > 0}>
          <div class="mb-2 flex flex-wrap gap-2">
            <For each={pendingAttachments()}>
              {(att, i) => (
                <div class="glass-inset relative flex items-center gap-2 rounded-md p-1 pr-2">
                  <img
                    src={`data:${att.mime};base64,${att.base64}`}
                    alt={att.name ?? "attached image"}
                    class="h-10 w-10 rounded object-cover"
                  />
                  <span class="max-w-[120px] truncate text-xs text-fg-3">
                    {att.name ?? formatBytes(att.bytes)}
                  </span>
                  <button
                    type="button"
                    title="Remove image"
                    aria-label="Remove image"
                    onClick={() =>
                      setPendingAttachments((prev) => prev.filter((_, j) => j !== i()))
                    }
                    class="lift -m-1 rounded p-1.5 text-fg-3 hover:text-fg-1"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="glass-inset flex items-end gap-2 rounded-lg p-2">
          <Show when={supportsImages()}>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              class="hidden"
              onChange={onPickFiles}
            />
            <button
              type="button"
              title="Attach image"
              aria-label="Attach image"
              onClick={() => fileInput?.click()}
              class="lift flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
            >
              <ImagePlus size={15} />
            </button>
          </Show>
          <textarea
            value={chatDraft()}
            onInput={(e) => setChatDraft(e.currentTarget.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={activeProviderId() ? "Ask the assistant…" : "Configure a provider first"}
            rows={2}
            disabled={!activeProviderId()}
            class="min-h-[40px] flex-1 resize-none rounded-md bg-transparent text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Show
            when={chatStreaming()}
            fallback={
              <button
                type="button"
                disabled={!activeProviderId() || !chatDraft().trim()}
                onClick={send}
                class="lift flex h-8 items-center gap-1.5 rounded-lg accent-grad px-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={12} stroke-width={2.2} />
                Send
              </button>
            }
          >
            <button
              type="button"
              onClick={stopChatStream}
              class="lift flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-danger-fill)] px-2.5 text-sm font-semibold text-white"
            >
              <Square size={12} stroke-width={2.2} />
              Stop
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};

const AiHeader: Component<{
  providerId: string | null;
  model: string;
  models: Array<{ id: string; displayName: string }>;
  modelsError: boolean;
  onModelChange: (id: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let pickerRef: HTMLDivElement | undefined;
  installDismiss(() => pickerRef, open, () => setOpen(false));
  useListboxOpenFocus(open, () => pickerRef);

  const selectedName = () =>
    props.models.find((m) => m.id === props.model)?.displayName ?? props.model;

  return (
    <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-3 py-2">
      <Sparkles class="ui-icon-sm flex-shrink-0 text-fg-3" />
      <span class="flex-shrink-0 text-sm font-medium text-fg-2">
        {labelForProvider(props.providerId)}
      </span>
      <ConversationSwitcher />
      <Show when={props.providerId && props.modelsError && props.models.length === 0}>
        <span class="ml-auto text-xs text-[var(--color-err)]">Models unavailable</span>
      </Show>
      <Show when={props.providerId && props.models.length > 0}>
        <div ref={pickerRef} class="relative ml-auto">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={open()}
            class="glass-inset flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          >
            <span class="max-w-[140px] truncate">{selectedName()}</span>
            <ChevronDown class="ui-icon-sm flex-shrink-0 text-fg-3" />
          </button>
          <Show when={open()}>
            <div
              role="listbox"
              tabindex={-1}
              onKeyDown={(e) => handleListboxKeydown(e, pickerRef, () => setOpen(false))}
              class="glass absolute right-0 top-full z-40 mt-1 max-h-[280px] min-w-[200px] overflow-auto scroll rounded-lg"
              style={{ padding: "4px", background: "var(--color-popover-bg)" }}
            >
              <For each={props.models}>
                {(model) => {
                  const active = () => props.model === model.id;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={active()}
                      tabindex={-1}
                      onClick={() => {
                        props.onModelChange(model.id);
                        setOpen(false);
                      }}
                      class={`lift flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                        active()
                          ? "bg-[var(--color-control-fill-hover)] text-fg-1"
                          : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                      }`}
                    >
                      <span class="min-w-0 flex-1 truncate">{model.displayName}</span>
                      <Show when={active()}>
                        <Check class="ui-icon-sm flex-shrink-0 text-[var(--color-accent-1)]" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

/** Header dropdown: list / create / delete this project's conversations. */
const ConversationSwitcher: Component = () => {
  const [open, setOpen] = createSignal(false);
  let menuRef: HTMLDivElement | undefined;
  installDismiss(() => menuRef, open, () => setOpen(false));

  const title = () => activeConversation()?.title ?? "New conversation";

  const startNew = () => {
    newConversation();
    setOpen(false);
  };

  return (
    <div ref={menuRef} class="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open()}
        title="Conversations"
        class="flex h-7 max-w-[200px] items-center gap-1 rounded-md px-1.5 text-sm text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
      >
        <History class="ui-icon-sm flex-shrink-0 text-fg-3" />
        <span class="min-w-0 truncate">{title()}</span>
        <ChevronDown class="ui-icon-sm flex-shrink-0 text-fg-3" />
      </button>
      <Show when={open()}>
        <div
          role="menu"
          class="glass absolute left-0 top-full z-40 mt-1 max-h-[320px] w-[260px] overflow-auto scroll rounded-lg"
          style={{ padding: "4px", background: "var(--color-popover-bg)" }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={startNew}
            class="lift flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-fg-1 hover:bg-[var(--color-control-fill)]"
          >
            <MessageSquarePlus class="ui-icon-sm text-fg-3" />
            New conversation
          </button>
          <Show when={conversations().length > 0}>
            <div class="my-1 border-t border-glass-stroke" />
          </Show>
          <For each={conversations()}>
            {(conv: Conversation) => {
              const active = () => conv.id === activeConversationId();
              return (
                <div
                  class={`group flex items-center gap-1 rounded-md ${
                    active()
                      ? "bg-[var(--color-control-fill-hover)]"
                      : "hover:bg-[var(--color-control-fill)]"
                  }`}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      selectConversation(conv.id);
                      setOpen(false);
                    }}
                    class="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm"
                  >
                    <span
                      class={`min-w-0 flex-1 truncate ${active() ? "text-fg-1" : "text-fg-2"}`}
                    >
                      {conv.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="Delete conversation"
                    aria-label={`Delete conversation "${conv.title}"`}
                    onClick={() => void deleteConversation(conv.id)}
                    class="-m-0.5 mr-0.5 rounded p-1.5 text-fg-4 opacity-0 hover:text-[var(--color-err)] group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

function labelForProvider(id: string | null): string {
  switch (id) {
    case "anthropic":
      return "Claude";
    case "openai":
      return "ChatGPT";
    case "gemini":
      return "Gemini";
    case "ollama":
      return "Ollama (local)";
    default:
      return "AI assistant";
  }
}

/** Sanitized-markdown body for a completed assistant turn. */
const AssistantMarkdown: Component<{ content: string }> = (props) => {
  let host: HTMLDivElement | undefined;
  createEffect(() => {
    const content = props.content;
    void renderAssistantMarkdown(content).then((html) => {
      if (!host) return;
      host.innerHTML = html;
      decorateCodeBlocks(host);
    });
  });
  return <div ref={host} class="md-preview ai-md select-text" />;
};

const MessageBubble: Component<{
  turn: ChatTurn;
  isLastAssistant: boolean;
  hasSelection: boolean;
}> = (props) => {
  const isUser = () => props.turn.role === "user";

  const copyTurn = async () => {
    try {
      await writeText(props.turn.content);
    } catch (e) {
      notifyError("Couldn't copy", describeIpcError(e));
    }
  };

  const insertTurn = () => {
    insertAtCursor(extractInsertText(props.turn.content));
  };

  const applyTurn = () => {
    if (!applyChatTextToSelection(extractInsertText(props.turn.content))) {
      notifyInfo("Select text in the editor first");
    }
  };

  return (
    <div class={`flex ${isUser() ? "justify-end" : "justify-start"}`}>
      <div class={`group flex max-w-[80%] flex-col gap-1 ${isUser() ? "items-end" : "items-start"}`}>
        <div
          class={`w-fit max-w-full select-text rounded-lg px-3 py-2 text-sm leading-relaxed ${
            isUser() ? "accent-grad" : "glass-soft text-fg-1"
          }`}
          style={isUser() ? { "white-space": "pre-wrap" } : undefined}
        >
          <Show when={!isUser()} fallback={props.turn.content}>
            <AssistantMarkdown content={props.turn.content} />
          </Show>
        </div>

        <Show when={isUser() && (props.turn.attachments?.length ?? 0) > 0}>
          <div class="flex flex-wrap justify-end gap-1.5">
            <For each={props.turn.attachments}>
              {(att: ChatAttachment) => (
                <Show
                  when={att.base64.length > 0}
                  fallback={
                    <span
                      class="glass-inset rounded px-2 py-0.5 text-xs text-fg-3"
                      title="Image payloads aren't saved — this image can't be re-sent after a reload."
                    >
                      image — {att.name ?? "pasted"}, {formatBytes(att.bytes)}
                    </span>
                  }
                >
                  <img
                    src={`data:${att.mime};base64,${att.base64}`}
                    alt={att.name ?? "attached image"}
                    class="h-16 max-w-[160px] rounded-md object-cover"
                  />
                </Show>
              )}
            </For>
          </div>
        </Show>

        <Show when={!isUser()}>
          <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Show when={props.turn.interrupted}>
              <span class="mr-1 rounded bg-[var(--color-control-fill)] px-1.5 py-0.5 text-[11px] text-fg-3">
                stopped
              </span>
            </Show>
            <BubbleAction
              label="Copy message"
              icon={<Copy size={12} />}
              onClick={() => void copyTurn()}
            />
            <BubbleAction
              label="Insert at cursor"
              icon={<SquarePen size={12} />}
              onClick={insertTurn}
            />
            <BubbleAction
              label={
                props.hasSelection
                  ? "Apply to selection (diff preview)"
                  : "Apply to selection — select text in the editor first"
              }
              icon={<Check size={12} />}
              disabled={!props.hasSelection}
              onClick={applyTurn}
            />
            <Show when={props.isLastAssistant}>
              <BubbleAction
                label="Regenerate"
                icon={<RotateCcw size={12} />}
                disabled={chatStreaming()}
                onClick={() => void regenerateLastTurn()}
              />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

const BubbleAction: Component<{
  label: string;
  icon: any;
  disabled?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    title={props.label}
    aria-label={props.label}
    disabled={props.disabled}
    onClick={props.onClick}
    class="lift flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
  >
    {props.icon}
  </button>
);

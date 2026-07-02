import { describeIpcError } from "~/lib/errors";
import { Check, ChevronDown, Send, Sparkles, Square } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";

import {
  activeProvider,
  activeProviderId,
} from "~/integrations/ai/registry";
import type { ChatMessage } from "~/integrations/types";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { integrationsSettings, setIntegrationsSettings } from "~/stores/settings-store";

/**
 * AI chat panel. Routes through the active provider from the AI
 * registry; the provider's `chat(messages, opts)` returns an
 * AsyncIterable of deltas which we accumulate into the streaming
 * assistant turn.
 *
 * Conversation state is in-memory per editor session. Persistence to
 * `<project>/.typeward/ai/conversations/*.jsonl` is a follow-up; for
 * Phase 4 the chat resets on app reload, which is fine for the typical
 * "ask, get answer, move on" usage that justifies the panel.
 */
export const AiView: Component = () => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [draft, setDraft] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  const [streamingText, setStreamingText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [modelsError, setModelsError] = createSignal(false);

  let abortController: AbortController | null = null;

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

  const send = async () => {
    setError(null);
    const prov = provider();
    const model = selectedModel();
    const text = draft().trim();
    if (!prov || !text) return;
    if (!model) {
      setError("No model available — the provider may be unreachable. Check Settings → Integrations → AI.");
      return;
    }
    if (streaming()) return;

    const userMessage: ChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setStreaming(true);
    setStreamingText("");

    abortController = new AbortController();
    try {
      let acc = "";
      for await (const chunk of prov.chat(messages(), { model, signal: abortController.signal })) {
        if (chunk.delta) {
          acc += chunk.delta;
          setStreamingText(acc);
        }
        if (chunk.done) break;
      }
      if (acc.length > 0) {
        setMessages((prev) => [...prev, { role: "assistant", content: acc }]);
      }
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setStreaming(false);
      setStreamingText("");
      abortController = null;
    }
  };

  const stop = () => {
    abortController?.abort();
  };

  const empty = createMemo(() => messages().length === 0 && !streaming());

  // Abort any in-flight stream when the pane unmounts (pane switch, project
  // close, navigation). Without this the Rust task + upstream HTTP request keep
  // running and billing tokens with no UI left to stop them.
  onCleanup(() => abortController?.abort());

  return (
    <div class="flex h-full flex-col" style={{ background: "var(--color-overlay-dim)" }}>
      <AiHeader
        providerId={activeProviderId()}
        model={selectedModel()}
        models={models() ?? []}
        modelsError={modelsError()}
        onModelChange={setSelectedModel}
      />

      <div class="flex-1 overflow-auto scroll px-4 py-4">
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
                    The chat stays scoped to this session; close the editor
                    and the history clears. Each provider keeps its own
                    selected model.
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
              <For each={messages()}>
                {(message) => <MessageBubble role={message.role} content={message.content} />}
              </For>
            </div>
            <Show when={streaming()}>
              <MessageBubble role="assistant" content={streamingText() || "…"} streaming />
            </Show>
          </div>
        </Show>
      </div>

      <Show when={error()}>
        <div
          role="alert"
          class="mx-2.5 mb-2 select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]"
        >
          {error()}
        </div>
      </Show>

      <div class="flex-shrink-0 border-t border-glass-stroke p-2.5">
        <div class="glass-inset flex items-end gap-2 rounded-lg p-2">
          <textarea
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={activeProviderId() ? "Ask the assistant…" : "Configure a provider first"}
            rows={2}
            disabled={!activeProviderId() || streaming()}
            class="min-h-[40px] flex-1 resize-none rounded-md bg-transparent text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Show
            when={streaming()}
            fallback={
              <button
                type="button"
                disabled={!activeProviderId() || !draft().trim()}
                onClick={() => void send()}
                class="lift flex h-8 items-center gap-1.5 rounded-lg accent-grad px-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={12} stroke-width={2.2} />
                Send
              </button>
            }
          >
            <button
              type="button"
              onClick={stop}
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
      <Sparkles class="ui-icon-sm text-fg-3" />
      <span class="text-sm font-medium text-fg-2">
        {labelForProvider(props.providerId)}
      </span>
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
            <span class="max-w-[180px] truncate">{selectedName()}</span>
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

const MessageBubble: Component<{
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
}> = (props) => (
  <div
    class={`flex ${props.role === "user" ? "justify-end" : "justify-start"}`}
  >
    <div
      class={`max-w-[80%] select-text rounded-lg px-3 py-2 text-sm leading-relaxed ${
        props.role === "user" ? "accent-grad" : "glass-soft text-fg-1"
      }`}
      style={{ "white-space": "pre-wrap" }}
    >
      {props.content}
      <Show when={props.streaming}>
        <span class="caret" />
      </Show>
    </div>
  </div>
);

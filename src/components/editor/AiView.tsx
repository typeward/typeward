import { Send, Sparkles, Square } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import {
  activeProvider,
  activeProviderId,
} from "~/integrations/ai/registry";
import type { ChatMessage } from "~/integrations/types";
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

  let abortController: AbortController | null = null;

  const provider = () => activeProvider(integrationsSettings().ai.ollamaBaseUrl);

  const [models] = createResource(
    () => [activeProviderId(), integrationsSettings().ai.ollamaBaseUrl] as const,
    async ([id]) => {
      if (!id) return [];
      try {
        return await provider()?.models() ?? [];
      } catch {
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
    if (!prov || !model || !text) return;
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
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <div class="flex h-full flex-col" style={{ background: "var(--color-overlay-dim)" }}>
      <AiHeader
        providerId={activeProviderId()}
        model={selectedModel()}
        models={models() ?? []}
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
              <h2 class="text-[length:var(--ui-font-lg)] font-semibold text-fg-1">
                {activeProviderId() ? "Ask anything" : "No AI provider configured"}
              </h2>
              <p class="text-[length:var(--ui-font-sm)] leading-relaxed text-fg-3">
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
            <For each={messages()}>
              {(message) => <MessageBubble role={message.role} content={message.content} />}
            </For>
            <Show when={streaming()}>
              <MessageBubble role="assistant" content={streamingText() || "…"} streaming />
            </Show>
          </div>
        </Show>
      </div>

      <Show when={error()}>
        <div class="mx-2.5 mb-2 rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-[length:var(--ui-font-sm)] text-[var(--color-err)]">
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
            class="min-h-[40px] flex-1 resize-none rounded-md bg-transparent text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Show
            when={streaming()}
            fallback={
              <button
                type="button"
                disabled={!activeProviderId() || !draft().trim()}
                onClick={() => void send()}
                class="lift flex h-8 items-center gap-1.5 rounded-md accent-grad px-2.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={12} stroke-width={2.2} />
                Send
              </button>
            }
          >
            <button
              type="button"
              onClick={stop}
              class="lift flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-err)] px-2.5 text-[12px] font-semibold text-white"
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
  onModelChange: (id: string) => void;
}> = (props) => (
  <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-3 py-2">
    <Sparkles class="ui-icon-sm text-fg-3" />
    <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-2">
      {labelForProvider(props.providerId)}
    </span>
    <Show when={props.providerId && props.models.length > 0}>
      <select
        value={props.model}
        onChange={(e) => props.onModelChange(e.currentTarget.value)}
        class="glass-inset ml-auto h-7 rounded-md px-2 text-[length:var(--ui-font-sm)] text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
      >
        <For each={props.models}>
          {(model) => <option value={model.id}>{model.displayName}</option>}
        </For>
      </select>
    </Show>
  </div>
);

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
      class={`max-w-[80%] rounded-lg px-3 py-2 text-[length:var(--ui-font-sm)] leading-relaxed ${
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

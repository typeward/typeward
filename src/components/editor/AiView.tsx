import { Sparkles, Send } from "lucide-solid";
import type { Component } from "solid-js";
import { createSignal } from "solid-js";

/**
 * AI assistant panel — UI shell only. The button toggle exists in the PDF
 * toolbar and routes preview-mode through `ui-store.previewMode === "ai"`.
 * Send button is disabled; we'll hook this up when an LLM provider config
 * lands in Settings.
 */
export const AiView: Component = () => {
  const [draft, setDraft] = createSignal("");
  return (
    <div class="flex h-full flex-col" style={{ background: "var(--color-overlay-dim)" }}>
      <div class="flex-1 overflow-auto scroll p-4">
        <div class="mx-auto flex max-w-[520px] flex-col items-center gap-3 pt-12 text-center">
          <span
            class="flex h-12 w-12 items-center justify-center rounded-2xl accent-grad"
            style={{ "box-shadow": "0 0 0 1px rgba(139,92,246,0.35)" }}
          >
            <Sparkles size={20} class="text-white" />
          </span>
          <h2 class="text-[length:var(--ui-font-lg)] font-semibold text-fg-1">
            AI assistant
          </h2>
          <p class="text-[length:var(--ui-font-sm)] leading-relaxed text-fg-3">
            The view is wired so it's ready when we plug in a model. For now,
            this is a placeholder — the toggle in the PDF toolbar swaps you
            here and back.
          </p>
          <div class="mono mt-2 rounded-md px-2 py-1 text-[11px] text-fg-4"
            style={{ background: "var(--color-control-fill)" }}>
            provider · pending Settings → AI section
          </div>
        </div>
      </div>
      <div class="flex-shrink-0 border-t border-glass-stroke p-2.5">
        <div class="glass-inset flex items-end gap-2 rounded-lg p-2">
          <textarea
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            placeholder="Ask the assistant…"
            rows={2}
            disabled
            class="min-h-[40px] flex-1 resize-none bg-transparent text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-4 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            disabled
            class="lift flex h-8 items-center gap-1.5 rounded-md accent-grad px-2.5 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send size={12} stroke-width={2.2} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

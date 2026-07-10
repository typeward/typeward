/**
 * Active AI provider tracking.
 *
 * Only one provider is "active" at a time — the settings card sets it, the
 * chat pane (ai-chat-store) and the selection-driven editor actions
 * (integrations/ai/actions.ts: Rewrite, Explain, …) all target it. The
 * registry also keeps a map of all instantiated providers keyed by id so
 * consumers can look one up without re-creating it.
 */

import { createSignal } from "solid-js";

import { hasEntitlement } from "~/integrations/entitlements";
import type { AiProvider } from "~/integrations/types";

import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import { createOllamaProvider } from "./ollama";
import { createOpenAIProvider } from "./openai";

// Single source of truth for the AI provider id space. The settings panel
// imports this (its AI_PROVIDERS card map is keyed by it) so adding an id here
// forces a matching settings card at compile time instead of a silent gap.
export type AiProviderId = "anthropic" | "openai" | "gemini" | "ollama";

const ALL_IDS: AiProviderId[] = ["anthropic", "openai", "gemini", "ollama"];

interface RegistryEntry {
  provider: AiProvider;
}

const [registry, setRegistry] = createSignal<Map<AiProviderId, RegistryEntry>>(new Map());
const [active, setActiveSignal] = createSignal<AiProviderId | null>(null);

export function getAvailableProviderIds(): readonly AiProviderId[] {
  return ALL_IDS;
}

/**
 * True when the current tier includes at least one AI provider. There is no
 * aggregate `integrations.ai` key, so surfaces that hide the whole AI UI
 * (settings card, chat pane, toolbar toggle) derive it from the per-provider
 * keys. Reactive inside tracking scopes — hasEntitlement reads the source
 * signal.
 */
export function hasAnyAiEntitlement(): boolean {
  return ALL_IDS.some((id) => hasEntitlement(`integrations.ai.${id}`));
}

export function getProvider(id: AiProviderId, ollamaBaseUrl?: string): AiProvider {
  const existing = registry().get(id);
  if (existing) return existing.provider;
  const provider = instantiate(id, ollamaBaseUrl);
  setRegistry((m) => {
    const next = new Map(m);
    next.set(id, { provider });
    return next;
  });
  return provider;
}

export function setActiveProvider(id: AiProviderId | null): void {
  setActiveSignal(id);
}

export const activeProviderId = active;

export function activeProvider(ollamaBaseUrl?: string): AiProvider | null {
  const id = active();
  if (!id) return null;
  return getProvider(id, ollamaBaseUrl);
}

function instantiate(id: AiProviderId, ollamaBaseUrl?: string): AiProvider {
  switch (id) {
    case "anthropic":
      return createAnthropicProvider();
    case "openai":
      return createOpenAIProvider();
    case "gemini":
      return createGeminiProvider();
    case "ollama":
      return createOllamaProvider(ollamaBaseUrl);
  }
}

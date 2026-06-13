/**
 * Reference-provider registry. Active providers register themselves here
 * (typically at app start via a settings-driven init); the aggregator and
 * UI surfaces read through this single source of truth.
 *
 * Phase 1 starts with zero providers registered. Each provider sub-module
 * (zotero / mendeley / doi-lookup) wires its `register()` call behind a
 * settings flag once the user opts in.
 */

import { createSignal } from "solid-js";

import type { CitationProvider } from "~/integrations/types";

const [providers, setProviders] = createSignal<readonly CitationProvider[]>([]);

/**
 * Register a provider. Returns an unregister thunk so callers (typically
 * the settings effect that watches `integrations.references.activeProvider`)
 * can drop the provider cleanly when the user disables it.
 */
export function registerCitationProvider(provider: CitationProvider): () => void {
  setProviders((list) => {
    if (list.some((p) => p.id === provider.id)) {
      return list.map((p) => (p.id === provider.id ? provider : p));
    }
    return [...list, provider];
  });
  return () => unregisterCitationProvider(provider.id);
}

export function unregisterCitationProvider(id: string): void {
  setProviders((list) => list.filter((p) => p.id !== id));
}

/** Reactive read of all registered providers. */
export const citationProviders = providers;

export function getCitationProvider(id: string): CitationProvider | undefined {
  return providers().find((p) => p.id === id);
}

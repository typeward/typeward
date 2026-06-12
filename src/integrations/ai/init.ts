/**
 * AI lifecycle. Reads `integrations.ai.activeProvider` from settings
 * and keeps the registry in sync with it. Mirrors the same pattern
 * references/init.ts uses.
 */

import { createEffect, createRoot } from "solid-js";

import { hasEntitlement } from "~/integrations/entitlements";
import { integrationsSettings } from "~/stores/settings-store";

import {
  type AiProviderId,
  getAvailableProviderIds,
  setActiveProvider,
} from "./registry";

export function initAiProviders(): void {
  createRoot(() => {
    createEffect(() => {
      const ai = integrationsSettings().ai;
      const desired = ai.activeProvider as AiProviderId | undefined;
      if (
        ai.enabled &&
        desired &&
        getAvailableProviderIds().includes(desired) &&
        hasEntitlement(`integrations.ai.${desired}`)
      ) {
        setActiveProvider(desired);
      } else {
        setActiveProvider(null);
      }
    });
  });
}

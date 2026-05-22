import { Lock } from "lucide-solid";
import type { Component } from "solid-js";

import type { EntitlementKey } from "~/integrations/types";

interface UpgradePromptProps {
  feature: EntitlementKey;
  title?: string;
  description?: string;
}

/**
 * Default fallback rendered by `<FeatureGate>` when the current entitlement
 * source denies the feature key. Intentionally compact — fits inside a
 * disabled-looking row, a setting card, or a sidebar pane without needing
 * its own modal. Phase 7 will wire the "Upgrade" affordance to the account
 * section once subscription management lands.
 */
export const UpgradePrompt: Component<UpgradePromptProps> = (props) => {
  return (
    <div class="glass-soft flex items-start gap-3 rounded-md border border-[var(--color-border)] px-3 py-2.5 text-fg-2">
      <Lock class="ui-icon-sm mt-0.5 shrink-0 text-[var(--color-fg-3)]" />
      <div class="flex-1 text-[var(--ui-font-sm)] leading-snug">
        <div class="text-fg-1 font-medium">{props.title ?? "Available on a paid plan"}</div>
        <div class="mt-0.5">
          {props.description ?? "Sign in and upgrade to unlock this integration."}
        </div>
        <div class="mt-1.5 text-[var(--color-fg-3)] text-[11px]">
          <span class="font-mono">{props.feature}</span>
        </div>
      </div>
    </div>
  );
};

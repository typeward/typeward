/**
 * TopBar tier indicator. Hidden when Supabase isn't configured or
 * nobody is signed in. Reads the active entitlement source so it stays
 * aligned with the gates used by integration surfaces.
 */

import type { Component } from "solid-js";
import { Show } from "solid-js";

import { currentTier } from "~/integrations/entitlements";
import { supabaseEnabled } from "~/integrations/supabase/client";
import { supabaseUser } from "~/integrations/supabase/session";

const PALETTE: Record<string, { bg: string; color: string }> = {
  free: { bg: "var(--color-control-fill)", color: "var(--color-fg-3)" },
  pro: { bg: "rgba(139, 92, 246, 0.16)", color: "rgb(167, 139, 250)" },
  team: { bg: "rgba(34, 197, 94, 0.16)", color: "rgb(74, 222, 128)" },
};

export const SubscriptionBadge: Component = () => {
  if (!supabaseEnabled()) return null;

  return (
    <Show when={supabaseUser()}>
      <span
        class="mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
        style={{
          background: PALETTE[currentTier()]?.bg,
          color: PALETTE[currentTier()]?.color,
        }}
        title={`Current plan: ${currentTier()}`}
      >
        {currentTier()}
      </span>
    </Show>
  );
};

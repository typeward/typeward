/**
 * TopBar tier indicator. Hidden when Supabase isn't configured or
 * nobody is signed in. Reads the active entitlement source so it stays
 * aligned with the gates used by integration surfaces.
 *
 * When the plan can't be verified (offline with an unusable cache), the
 * entitlement source collapses to the free tier — asserting "FREE" then
 * would be a lie about the account. The badge shows an explicit
 * "unverified" state with a click-to-retry instead, so a paying user who
 * lost half the editor at least sees why.
 */

import type { Component } from "solid-js";
import { Show } from "solid-js";

import { currentTier } from "~/integrations/entitlements";
import { supabaseEnabled } from "~/integrations/supabase/client";
import {
  entitlementSyncStatus,
  refreshEntitlements,
} from "~/integrations/supabase/entitlements-source";
import { supabaseUser } from "~/integrations/supabase/session";

const PALETTE: Record<string, { bg: string; color: string }> = {
  free: { bg: "var(--color-control-fill)", color: "var(--color-fg-3)" },
  pro: {
    bg: "color-mix(in srgb, var(--color-accent-1) 16%, transparent)",
    color: "var(--color-accent-1)",
  },
};

export const SubscriptionBadge: Component = () => {
  if (!supabaseEnabled()) return null;

  const unverified = () => entitlementSyncStatus() === "offline-uncached";

  return (
    <Show when={supabaseUser()}>
      <Show
        when={unverified()}
        fallback={
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
        }
      >
        <button
          type="button"
          class="lift mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
          style={{
            background: "color-mix(in srgb, var(--color-warn) 14%, transparent)",
            color: "var(--color-warn)",
          }}
          title="Couldn't verify your plan — paid features are temporarily unavailable. Click to retry."
          onClick={() => void refreshEntitlements()}
        >
          plan unverified
        </button>
      </Show>
    </Show>
  );
};

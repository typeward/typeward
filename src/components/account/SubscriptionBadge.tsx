/**
 * TopBar tier indicator. Hidden when Supabase isn't configured or
 * nobody is signed in. Reads the plan via a one-shot `subscriptions`
 * row lookup on session change — same path the AccountSection uses.
 *
 * Once Phase 7.4 swaps in the real EntitlementSource this should
 * switch to reading from `currentTier()` so we don't double-query
 * Supabase per render.
 */

import type { Component } from "solid-js";
import { Show, createResource } from "solid-js";

import { getSupabaseClient, supabaseEnabled } from "~/integrations/supabase/client";
import { supabaseUser } from "~/integrations/supabase/session";

const PALETTE: Record<string, { bg: string; color: string }> = {
  free: { bg: "var(--color-control-fill)", color: "var(--color-fg-3)" },
  pro: { bg: "rgba(139, 92, 246, 0.16)", color: "rgb(167, 139, 250)" },
  team: { bg: "rgba(34, 197, 94, 0.16)", color: "rgb(74, 222, 128)" },
};

export const SubscriptionBadge: Component = () => {
  if (!supabaseEnabled()) return null;

  const [plan] = createResource(
    () => supabaseUser()?.id,
    async (userId) => {
      if (!userId) return null;
      const client = getSupabaseClient();
      if (!client) return null;
      const { data } = await client
        .from("subscriptions")
        .select("plan_id,status")
        .eq("user_id", userId)
        .in("status", ["active", "trialing"])
        .maybeSingle();
      return data?.plan_id ?? "free";
    },
  );

  return (
    <Show when={supabaseUser()}>
      <span
        class="mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
        style={{
          background: PALETTE[plan() ?? "free"]?.bg,
          color: PALETTE[plan() ?? "free"]?.color,
        }}
        title={`Current plan: ${plan() ?? "free"}`}
      >
        {plan() ?? "free"}
      </span>
    </Show>
  );
};

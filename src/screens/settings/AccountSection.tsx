/**
 * Settings → Account section.
 *
 * Email/password sign-in + sign-out + a tier badge. Visible only when
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are wired — otherwise
 * the section collapses to a "Supabase isn't configured" hint and the
 * rest of the app stays in free-tier-everywhere mode.
 *
 * The entitlement source swaps to the user's subscription after sign-in.
 * The plan query here is only a compact account summary; the gates
 * themselves read from `src/integrations/entitlements.ts`.
 *
 * Billing is NOT handled in the app — plans are purchased and managed on
 * the Typeward website (`ACCOUNT_BILLING_URL` in src/config/pro.ts).
 * Signed-in users get a link out to it; the app only reads the resulting
 * subscription tier.
 */

import {
  AlertTriangle,
  ExternalLink,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
} from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Component } from "solid-js";
import { Show, createResource, createSignal } from "solid-js";

import { SignInForm } from "~/components/account/SignInForm";
import { errorText, notifyError } from "~/components/feedback/Toaster";
import { Switch } from "~/components/forms/Switch";
import { Button } from "~/components/primitives/Button";
import { ACCOUNT_BILLING_URL, PRO_DISCOVERY_ENABLED } from "~/config/pro";
import {
  getSupabaseClient,
  supabaseEnabled,
} from "~/integrations/supabase/client";
import { refreshEntitlements } from "~/integrations/supabase/entitlements-source";
import {
  signOut,
  supabaseSession,
  supabaseSessionReady,
  supabaseUser,
} from "~/integrations/supabase/session";
import {
  setSyncSettingsEnabled,
  syncSettingsEnabled,
} from "~/stores/settings-store";

export const AccountSection: Component = () => {
  return (
    <Show
      when={supabaseEnabled()}
      fallback={
        <Card title="Account" subtitle="Supabase isn't configured for this build.">
          <div class="px-5 py-4 text-sm text-fg-3">
            Set <span class="mono">VITE_SUPABASE_URL</span> and{" "}
            <span class="mono">VITE_SUPABASE_ANON_KEY</span> in{" "}
            <span class="mono">.env.local</span> to enable sign-in. The rest of
            Typeward works without it — you'll just stay on the free tier and
            no cloud-gated features will unlock.
          </div>
        </Card>
      }
    >
      <Show
        when={supabaseSessionReady()}
        fallback={<Card title="Account"><div class="px-5 py-4 text-sm text-fg-3">Restoring session…</div></Card>}
      >
        <Show when={supabaseSession()} fallback={<SignInCard />}>
          <SignedInCard />
        </Show>
      </Show>
    </Show>
  );
};

// The form itself lives in ~/components/account/SignInForm — shared with the
// onboarding account step so the auth path can't fork.
const SignInCard: Component = () => (
  <Card
    title="Sign in"
    subtitle="Email + password. Sessions persist in your OS keyring, not in plaintext on disk."
  >
    <div class="px-5 py-4">
      <SignInForm />
    </div>
  </Card>
);

const SignedInCard: Component = () => {
  const user = () => supabaseUser();
  const [planSummary, { refetch: refetchPlan }] = createResource(
    () => user()?.id,
    async (userId): Promise<{ planId: string; status: string } | null> => {
      if (!userId) return null;
      const client = getSupabaseClient();
      if (!client) return null;
      const { data, error } = await client
        .from("subscriptions")
        .select("plan_id,status")
        .eq("user_id", userId)
        .maybeSingle();
      // A failed query (offline, RLS hiccup) must not masquerade as "Free" —
      // surface a distinct sentinel the badge renders as an em-dash.
      if (error) return { planId: "unknown", status: "error" };
      if (!data) return null;
      return { planId: data.plan_id, status: data.status };
    },
  );

  const [refreshing, setRefreshing] = createSignal(false);
  const handleRefreshPlan = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      await refreshEntitlements();
      await refetchPlan();
    } catch (e) {
      notifyError("Couldn't refresh your plan", errorText(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (e) {
      notifyError("Couldn't sign out", errorText(e));
    }
  };

  return (
    <Card
      title="Account"
      subtitle="Signed in. Your session is stored in the OS keyring; sign out to wipe it."
    >
      <div class="flex flex-col gap-3 px-5 py-4">
        <div class="flex items-center gap-3">
          <Mail class="ui-icon-sm text-fg-3" />
          <span class="text-sm text-fg-1">{user()?.email}</span>
          <PlanBadge plan={planSummary()?.planId ?? "free"} />
        </div>
        <Show when={planSummary()?.status === "error"}>
          <div class="flex items-center gap-2 text-xs text-fg-3">
            <span>Couldn't load your plan.</span>
            <Button variant="ghost" size="sm" onClick={() => void refetchPlan()}>
              Retry
            </Button>
          </div>
        </Show>
        <Show when={planSummary()?.status === "past_due"}>
          <div
            class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
            style={{
              background: "color-mix(in srgb, var(--color-warn) 10%, transparent)",
              "border-color": "color-mix(in srgb, var(--color-warn) 35%, transparent)",
              color: "var(--color-warn)",
            }}
          >
            <AlertTriangle class="ui-icon-sm shrink-0" />
            <span class="flex-1">Payment issue — update your card.</span>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<ExternalLink class="ui-icon-sm" />}
              onClick={() => void openUrl(ACCOUNT_BILLING_URL)}
            >
              Update card
            </Button>
          </div>
        </Show>
        <Show
          when={
            planSummary()?.status &&
            planSummary()!.status !== "active" &&
            planSummary()!.status !== "error" &&
            planSummary()!.status !== "past_due"
          }
        >
          <div class="text-xs text-fg-3">
            Subscription status:{" "}
            <span class="mono text-fg-2">{planSummary()?.status}</span>
          </div>
        </Show>
        {/* Device-local toggle (never synced itself): governs whether THIS
            machine pushes/pulls the synced preference keys. Only rendered
            signed-in — sync is meaningless without an account. */}
        <div class="border-t border-glass-stroke pt-3">
          <Switch
            checked={syncSettingsEnabled()}
            onChange={setSyncSettingsEnabled}
            label="Sync settings across devices"
            description="Syncs your preferences (theme, editor, workspace). Never syncs accounts, keys, or file paths — and this toggle stays on this device."
          />
        </div>
        <div class="flex items-center gap-2">
          {/* No purchasable Pro during the free-only beta — the billing CTA
              hides; the plan badge and "Refresh plan" stay. */}
          <Show when={PRO_DISCOVERY_ENABLED}>
            <Button
              variant="primary"
              leadingIcon={<ExternalLink class="ui-icon-sm" />}
              onClick={() => void openUrl(ACCOUNT_BILLING_URL)}
            >
              Manage plan & billing
            </Button>
          </Show>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={
              <RefreshCw class={refreshing() ? "ui-icon-sm animate-spin" : "ui-icon-sm"} />
            }
            disabled={refreshing()}
            onClick={() => void handleRefreshPlan()}
          >
            {refreshing() ? "Refreshing…" : "Refresh plan"}
          </Button>
          <Button
            variant="ghost"
            leadingIcon={<LogOut class="ui-icon-sm" />}
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-fg-3">
          <ShieldCheck class="ui-icon-sm" />
          <span>
            {PRO_DISCOVERY_ENABLED
              ? "Plans are purchased and managed on the Typeward website. Paid integrations unlock from the entitlement tier on your subscription; sign-out returns to the free-tier matrix."
              : "Your plan is read from your account subscription; sign-out returns to the free-tier matrix."}
          </span>
        </div>
      </div>
    </Card>
  );
};

const PlanBadge: Component<{ plan: string }> = (props) => {
  const label = () =>
    props.plan === "pro" ? "Pro" : props.plan === "unknown" ? "—" : "Free";
  const bg = () =>
    props.plan === "pro"
      ? "color-mix(in srgb, var(--color-accent-1) 16%, transparent)"
      : "var(--color-control-fill)";
  const color = () =>
    props.plan === "pro" ? "var(--color-accent-1)" : "var(--color-fg-3)";

  return (
    <span
      class="mono ml-auto rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ background: bg(), color: color() }}
    >
      {label()}
    </span>
  );
};

const Card: Component<{
  title: string;
  subtitle?: string;
  children: import("solid-js").JSX.Element;
}> = (props) => (
  <div class="glass overflow-hidden rounded-xl">
    <div class="border-b border-glass-stroke px-5 py-4">
      <div class="text-base font-semibold tracking-tight text-fg-1">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="mt-0.5 text-sm leading-relaxed text-fg-2">{props.subtitle}</div>
      </Show>
    </div>
    <div>{props.children}</div>
  </div>
);

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
 */

import { LogIn, LogOut, Mail, ShieldCheck } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createResource, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import {
  getSupabaseClient,
  supabaseEnabled,
} from "~/integrations/supabase/client";
import {
  signOut,
  supabaseSession,
  supabaseSessionReady,
  supabaseUser,
} from "~/integrations/supabase/session";

export const AccountSection: Component = () => {
  return (
    <Show
      when={supabaseEnabled()}
      fallback={
        <Card title="Account" subtitle="Supabase isn't configured for this build.">
          <div class="px-5 py-4 text-[12px] text-fg-3">
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
        fallback={<Card title="Account"><div class="px-5 py-4 text-[12px] text-fg-3">Restoring session…</div></Card>}
      >
        <Show when={supabaseSession()} fallback={<SignInCard />}>
          <SignedInCard />
        </Show>
      </Show>
    </Show>
  );
};

const SignInCard: Component = () => {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleSignIn = async () => {
    setError(null);
    const client = getSupabaseClient();
    if (!client) {
      setError("Supabase client isn't initialized.");
      return;
    }
    if (!email().trim() || !password()) {
      setError("Email and password are required.");
      return;
    }
    setBusy(true);
    try {
      const { error: authError } = await client.auth.signInWithPassword({
        email: email().trim(),
        password: password(),
      });
      if (authError) throw new Error(authError.message);
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Sign in"
      subtitle="Email + password. Sessions persist in your OS keyring, not in plaintext on disk."
    >
      <div class="flex flex-col gap-3 px-5 py-4">
        <label class="flex flex-col gap-1">
          <span class="text-[12px] font-medium text-fg-2">Email</span>
          <input
            type="email"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
            placeholder="you@example.com"
            class="glass-inset h-9 rounded-md px-2.5 text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] font-medium text-fg-2">Password</span>
          <input
            type="password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSignIn();
              }
            }}
            class="glass-inset h-9 rounded-md px-2.5 text-[12px] text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
        </label>
        <Show when={error()}>
          <div class="rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-[12px] text-[var(--color-err)]">
            {error()}
          </div>
        </Show>
        <Button
          variant="primary"
          leadingIcon={<LogIn class="ui-icon-sm" />}
          disabled={busy()}
          onClick={handleSignIn}
        >
          {busy() ? "Signing in…" : "Sign in"}
        </Button>
        <div class="text-[11px] text-fg-3">
          No account? Sign-up happens via the dashboard for now — self-serve
          registration in the app lands with the billing rollout.
        </div>
      </div>
    </Card>
  );
};

const SignedInCard: Component = () => {
  const user = () => supabaseUser();
  const [planSummary, { refetch: refetchPlan }] = createResource(
    () => user()?.id,
    async (userId): Promise<{ planId: string; status: string } | null> => {
      if (!userId) return null;
      const client = getSupabaseClient();
      if (!client) return null;
      const { data } = await client
        .from("subscriptions")
        .select("plan_id,status")
        .eq("user_id", userId)
        .maybeSingle();
      if (!data) return null;
      return { planId: data.plan_id, status: data.status };
    },
  );

  void refetchPlan;

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <Card
      title="Account"
      subtitle="Signed in. Your session is stored in the OS keyring; sign out to wipe it."
    >
      <div class="flex flex-col gap-3 px-5 py-4">
        <div class="flex items-center gap-3">
          <Mail class="ui-icon-sm text-fg-3" />
          <span class="text-[length:var(--ui-font-sm)] text-fg-1">{user()?.email}</span>
          <PlanBadge plan={planSummary()?.planId ?? "free"} />
        </div>
        <Show when={planSummary()?.status && planSummary()!.status !== "active"}>
          <div class="text-[11px] text-fg-3">
            Subscription status:{" "}
            <span class="mono text-fg-2">{planSummary()?.status}</span>
          </div>
        </Show>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            leadingIcon={<LogOut class="ui-icon-sm" />}
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </div>
        <div class="flex items-center gap-1.5 text-[11px] text-fg-3">
          <ShieldCheck class="ui-icon-sm" />
          <span>
            Paid integrations are gated by the current entitlement source.
            Sign-out returns to the free-tier matrix.
          </span>
        </div>
      </div>
    </Card>
  );
};

const PlanBadge: Component<{ plan: string }> = (props) => {
  const label = () =>
    props.plan === "pro"
      ? "Pro"
      : props.plan === "team"
        ? "Team"
        : "Free";
  const bg = () =>
    props.plan === "pro"
      ? "rgba(139, 92, 246, 0.16)"
      : props.plan === "team"
        ? "rgba(34, 197, 94, 0.16)"
        : "var(--color-control-fill)";
  const color = () =>
    props.plan === "pro"
      ? "rgb(167, 139, 250)"
      : props.plan === "team"
        ? "rgb(74, 222, 128)"
        : "var(--color-fg-3)";

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
      <div class="text-[14px] font-semibold tracking-tight text-fg-1">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="mt-0.5 text-[12px] leading-relaxed text-fg-2">{props.subtitle}</div>
      </Show>
    </div>
    <div>{props.children}</div>
  </div>
);

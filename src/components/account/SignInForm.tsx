/**
 * Email/password sign-in form — the single in-app auth path, shared by
 * Settings → Account and the onboarding account step (chrome differs per
 * host; the flow must not fork). Sign-up stays on the Typeward website
 * (ACCOUNT_BILLING_URL); the app only signs existing accounts in.
 */

import { ExternalLink, LogIn } from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { ACCOUNT_BILLING_URL, PRO_DISCOVERY_ENABLED } from "~/config/pro";
import { describeIpcError } from "~/integrations/auth/chunked";
import { getSupabaseClient } from "~/integrations/supabase/client";

export const SignInForm: Component = () => {
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
      // describeIpcError: Tauri IPC rejections are serialized error enums
      // (objects) — String() would render them as "[object Object]".
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-fg-2">Email</span>
        <input
          type="email"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
          placeholder="you@example.com"
          class="glass-inset h-9 rounded-md px-2.5 text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-fg-2">Password</span>
        <input
          type="password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              void handleSignIn();
            }
          }}
          class="glass-inset h-9 rounded-md px-2.5 text-sm text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
        />
      </label>
      <Show when={error()}>
        <div class="select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]">
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
      <div class="flex flex-col gap-2 text-xs text-fg-3">
        {/* Plan-choice copy is Pro discovery; the account link itself stays
            (a free account powers settings sync). */}
        <span>
          {PRO_DISCOVERY_ENABLED
            ? "No account yet? Sign up and choose a plan on the Typeward website, then sign in here."
            : "No account yet? Create a free one on the Typeward website, then sign in here."}
        </span>
        <button
          type="button"
          onClick={() => void openUrl(ACCOUNT_BILLING_URL)}
          class="lift flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
        >
          <ExternalLink class="ui-icon-sm" />
          Create an account
        </button>
      </div>
    </div>
  );
};

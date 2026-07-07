import { Check, ExternalLink, ShieldCheck } from "lucide-solid";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Component } from "solid-js";
import { For, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import {
  ACCOUNT_BILLING_URL,
  PRO_FEATURES,
  PRO_PRICING_LINE,
} from "~/config/pro";
import { requestProDialog_, setRequestProDialog } from "~/commands/palette-store";
import { currentTier } from "~/integrations/entitlements";
import { supabaseEnabled } from "~/integrations/supabase/client";
import { supabaseUser } from "~/integrations/supabase/session";

/**
 * "What's in Pro" dialog. Mounted once at the App root (lazily, like
 * SaveTemplateDialog) and opened via the `requestProDialog` signal — from
 * the `core.whatsInPro` command, ProChips, locked panels, and onboarding.
 * Informational only: the CTA links out to the website; no purchase happens
 * in-app and nothing here blocks or nags.
 */
export const ProDialog: Component = () => {
  const close = () => setRequestProDialog(false);
  const isPro = () => currentTier() === "pro";
  // "Sign in" only helps when Supabase is wired and nobody is signed in.
  const showSignInHint = () => supabaseEnabled() && !supabaseUser();

  return (
    <Dialog
      open={requestProDialog_()}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Typeward Pro"
      description={
        isPro()
          ? undefined
          : "The free tier is the full LaTeX editor. Pro adds the connected workflow."
      }
      widthClass="w-[480px]"
      footer={
        <Show
          when={!isPro()}
          fallback={
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
          }
        >
          <>
            <Button variant="ghost" onClick={close}>
              Not now
            </Button>
            <Button
              variant="primary"
              leadingIcon={<ExternalLink class="ui-icon-sm" />}
              onClick={() => void openUrl(ACCOUNT_BILLING_URL)}
            >
              Get Pro
            </Button>
          </>
        </Show>
      }
    >
      <Show when={!isPro()} fallback={<ProActiveState />}>
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-2.5">
            <For each={PRO_FEATURES}>
              {(f) => (
                <div class="flex items-start gap-2.5">
                  <Check
                    size={13}
                    stroke-width={2.5}
                    class="mt-0.5 flex-shrink-0"
                    style={{ color: "var(--color-accent-1)" }}
                  />
                  <div class="min-w-0">
                    <span class="text-sm font-medium text-fg-1">{f.label}</span>
                    <span class="text-sm text-fg-3"> — {f.detail}</span>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div class="border-t border-glass-stroke pt-3 text-sm text-fg-2">
            {PRO_PRICING_LINE}
          </div>
          <Show when={showSignInHint()}>
            <div class="text-xs text-fg-3">
              Already subscribed? Sign in under Settings → Account.
            </div>
          </Show>
        </div>
      </Show>
    </Dialog>
  );
};

const ProActiveState: Component = () => (
  <div class="flex flex-col items-center gap-2 py-4 text-center">
    <div
      class="flex h-10 w-10 items-center justify-center rounded-full"
      style={{
        background: "color-mix(in srgb, var(--color-accent-1) 14%, transparent)",
      }}
    >
      <ShieldCheck size={18} style={{ color: "var(--color-accent-1)" }} />
    </div>
    <div class="text-base font-medium text-fg-1">You're on Pro</div>
    <div class="text-sm text-fg-3">
      Everything is unlocked. Manage your plan under Settings → Account.
    </div>
  </div>
);

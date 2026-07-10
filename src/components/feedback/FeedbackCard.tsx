import { MessageSquare, Send, X } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createEffect, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import {
  type FeedbackCardMode,
  requestFeedbackCard_,
  setRequestFeedbackCard,
} from "~/commands/palette-store";
import { openBugReport } from "~/lib/bug-report";
import { describeIpcError } from "~/lib/errors";
import {
  type FeedbackPromptState,
  initialPromptState,
  loadPromptState,
  markDismissed,
  markSubmitted,
  savePromptState,
} from "~/lib/feedback-prompt";
import {
  FEEDBACK_MAX_DESCRIPTION,
  buildFeedbackPayload,
  isValidFeedbackEmail,
  submitFeedback,
} from "~/lib/feedback-submit";
import { recordError } from "~/lib/telemetry";
import { notifyError, notifyInfo } from "~/lib/toast";
import { setFeedbackPromptsEnabled } from "~/stores/settings-store";

/**
 * Small non-modal corner card that collects free-text feedback. Mounted lazily
 * once at the App root; opened by the trigger engine (feedback-prompt.ts,
 * mode "prompted") or the core.sendFeedback command (mode "manual").
 *
 * Prompted opens feed the trigger state: Later/close counts a dismissal,
 * a successful send marks it submitted (stopping future prompts), and
 * "Don't ask again" flips the synced feedback.promptsEnabled setting.
 * Manual opens never consume trigger state — except that a successful send
 * still marks submitted, since asking again after feedback arrived is noise.
 *
 * Deliberately NOT a Dialog: no focus trap, no backdrop, no outside-click
 * dismiss (a stray click must not eat typed text). It sits under the toast
 * layer so a submit-failure toast stays visible above it.
 */
export const FeedbackCard: Component = () => {
  const [text, setText] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);

  // Reset only on the closed -> open edge so a mode change mid-open (e.g. the
  // palette command while prompted) can't wipe half-typed feedback.
  let prevMode: FeedbackCardMode | null = null;
  createEffect(() => {
    const mode = requestFeedbackCard_();
    if (mode && !prevMode) {
      setText("");
      setEmail("");
      setBusy(false);
      setError(null);
      setSent(false);
    }
    prevMode = mode;
  });

  const prompted = () => requestFeedbackCard_() === "prompted";
  const close = () => setRequestFeedbackCard(null);

  const updateState = (fn: (s: FeedbackPromptState) => FeedbackPromptState) => {
    savePromptState(fn(loadPromptState() ?? initialPromptState(Date.now())));
  };

  const dismiss = () => {
    // Thank-you state or manual open: closing is not a "no thanks".
    if (prompted() && !sent()) updateState(markDismissed);
    close();
  };

  const dontAskAgain = () => {
    setFeedbackPromptsEnabled(false);
    notifyInfo(
      "Feedback prompts turned off",
      "You can re-enable them anytime in Settings under Security, or send feedback from the command palette.",
    );
    close();
  };

  const send = async () => {
    if (busy() || !text().trim()) return;
    if (email().trim() && !isValidFeedbackEmail(email().trim())) {
      setError("That email address doesn't look right — fix it or leave it empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let info = null;
      try {
        const ipc = await import("~/ipc");
        info = await ipc.collectSystemInfo();
      } catch {
        // Non-Tauri context or probe failure — send without system info.
      }
      await submitFeedback(buildFeedbackPayload(text(), email(), info));
      updateState(markSubmitted);
      setSent(true);
    } catch (e) {
      recordError("feedback", "feedback submission failed", e);
      setError(describeIpcError(e));
      notifyError(
        "Couldn't send feedback",
        "You can try again in a moment, or use the GitHub report link on the card.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={requestFeedbackCard_()}>
      <section
        aria-label="Send feedback"
        class="glass fixed bottom-4 right-4 z-[9000] w-[min(380px,calc(100vw-32px))] rounded-xl p-4"
        style={{ background: "var(--color-popover-bg)" }}
      >
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 flex-shrink-0" style={{ color: "var(--color-accent-1)" }}>
            <MessageSquare class="ui-icon-sm" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-fg-1">
              {sent() ? "Thanks for the feedback!" : "How is Typeward working for you?"}
            </div>
            <Show when={!sent()}>
              <p class="mt-0.5 text-xs leading-relaxed text-fg-3">
                Rough edges, missing pieces, small wins — a sentence is plenty.
              </p>
            </Show>
          </div>
          <button
            type="button"
            class="lift -m-1 flex-shrink-0 rounded p-1 text-fg-3 hover:text-fg-1"
            aria-label="Close feedback card"
            onClick={dismiss}
          >
            <X class="ui-icon-sm" />
          </button>
        </div>

        <Show
          when={!sent()}
          fallback={
            <div class="mt-3 flex items-center justify-between gap-3">
              <p class="text-xs leading-relaxed text-fg-3">
                It went straight to the people building this. We read everything.
              </p>
              <Button variant="secondary" size="sm" onClick={close}>
                Done
              </Button>
            </div>
          }
        >
          <div class="mt-3 flex flex-col gap-2">
            <textarea
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              placeholder="What should we improve?"
              rows={3}
              maxLength={FEEDBACK_MAX_DESCRIPTION}
              class="glass-inset w-full resize-none rounded-md px-3 py-2 text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
            />
            <div class="flex items-center gap-2">
              <input
                type="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                placeholder="Email for a reply (optional)"
                maxLength={200}
                class="glass-inset h-8 min-w-0 flex-1 rounded-md px-3 text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
              />
              <Show when={text().length > FEEDBACK_MAX_DESCRIPTION - 200}>
                <span class="flex-shrink-0 text-xs tabular-nums text-fg-3">
                  {text().length}/{FEEDBACK_MAX_DESCRIPTION}
                </span>
              </Show>
            </div>

            <Show when={error()}>
              <div class="select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-xs text-[var(--color-err)]">
                <div>{error()}</div>
                <button
                  type="button"
                  class="lift mt-1 font-medium underline underline-offset-2"
                  onClick={() => void openBugReport()}
                >
                  Report on GitHub instead
                </button>
              </div>
            </Show>

            <div class="mt-1 flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Send class="ui-icon-sm" />}
                disabled={busy() || !text().trim()}
                onClick={() => void send()}
              >
                {busy() ? "Sending…" : "Send"}
              </Button>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <div class="flex-1" />
              <Show when={prompted()}>
                <button
                  type="button"
                  class="lift rounded px-1.5 py-1 text-xs text-fg-3 hover:text-fg-1"
                  onClick={dontAskAgain}
                >
                  Don't ask again
                </button>
              </Show>
            </div>
            <p class="text-xs text-fg-3">Sent with your app version and OS, nothing else.</p>
          </div>
        </Show>
      </section>
    </Show>
  );
};

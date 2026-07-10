/**
 * Occasional "give us feedback" prompt — trigger engine.
 *
 * The decision core is pure (injected clock + RNG) so every boundary is unit
 * testable. Pacing state is DEVICE-LOCAL in localStorage (the documented home
 * for device-local UI state, next to the panel-state keys): whether THIS
 * machine asked recently must not follow the account, and a cleared webview
 * cache merely re-arms the first-week/first-sessions ramp. The one synced
 * value is the `feedback.promptsEnabled` setting (settings-store).
 *
 * The wiring at the bottom follows scheduleBootUpdateCheck's shape: a one-shot
 * post-boot deferral that never blocks startup and never fires over the
 * onboarding screen. Manual opens (core.sendFeedback) bypass this module
 * entirely — they neither consult nor consume any of this state.
 */

import { createEffect, createRoot } from "solid-js";

import { setRequestFeedbackCard } from "~/commands/palette-store";
import { isPreviewWindow } from "~/lib/window-role";
import {
  feedbackPromptsEnabled,
  onboarded,
  settingsLoaded,
} from "~/stores/settings-store";

export interface FeedbackPromptState {
  /** Epoch ms of the first app start that ran this engine. */
  firstRunAt: number;
  /** App starts seen so far (this one included). */
  sessionCount: number;
  /** Epoch ms the trigger last raised the card; manual opens never set it. */
  lastShownAt: number | null;
  /** Dismissals without engagement; MAX_DISMISSALS stops the prompt for good. */
  dismissCount: number;
  /** One successful submission stops the prompt permanently. */
  submitted: boolean;
}

export const MIN_DAYS_SINCE_FIRST_RUN = 7;
export const MIN_SESSIONS = 5;
/** Per-app-start chance once eligible — occasional, not inevitable. */
export const SHOW_CHANCE = 0.15;
export const COOLDOWN_DAYS = 30;
export const MAX_DISMISSALS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export function initialPromptState(now: number): FeedbackPromptState {
  return {
    firstRunAt: now,
    sessionCount: 0,
    lastShownAt: null,
    dismissCount: 0,
    submitted: false,
  };
}

/** One app start = one session. Seeds firstRunAt on the very first run. */
export function recordSession(
  state: FeedbackPromptState | null,
  now: number,
): FeedbackPromptState {
  const base = state ?? initialPromptState(now);
  return { ...base, sessionCount: base.sessionCount + 1 };
}

export interface PromptDecisionInput {
  now: number;
  /** Injectable RNG in [0, 1). */
  random: () => number;
  promptsEnabled: boolean;
  onboardingCompleted: boolean;
  /** True when this session started un-onboarded — onboarding ran (or will
   *  run) this session, and the prompt must never share it. */
  onboardedThisSession: boolean;
}

export function shouldShowPrompt(
  state: FeedbackPromptState,
  input: PromptDecisionInput,
): boolean {
  if (!input.promptsEnabled) return false;
  if (!input.onboardingCompleted || input.onboardedThisSession) return false;
  if (state.submitted) return false;
  if (state.dismissCount >= MAX_DISMISSALS) return false;
  if (input.now - state.firstRunAt < MIN_DAYS_SINCE_FIRST_RUN * DAY_MS) return false;
  if (state.sessionCount < MIN_SESSIONS) return false;
  if (
    state.lastShownAt !== null &&
    input.now - state.lastShownAt < COOLDOWN_DAYS * DAY_MS
  ) {
    return false;
  }
  return input.random() < SHOW_CHANCE;
}

/** A raise counts as shown even when submission later fails — the cooldown
 *  paces how often the user is asked, not how often we succeed. */
export function markShown(
  state: FeedbackPromptState,
  now: number,
): FeedbackPromptState {
  return { ...state, lastShownAt: now };
}

export function markDismissed(state: FeedbackPromptState): FeedbackPromptState {
  return { ...state, dismissCount: state.dismissCount + 1 };
}

export function markSubmitted(state: FeedbackPromptState): FeedbackPromptState {
  return { ...state, submitted: true };
}

// ---------------------------------------------------------------------------
// Persistence (device-local).

const STORAGE_KEY = "typeward.feedback-prompt";

/** localStorage is an external boundary — coerce field-by-field; garbage
 *  degrades to null (a fresh ramp) rather than a crash or a stuck prompt. */
export function parsePromptState(raw: string | null): FeedbackPromptState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FeedbackPromptState> | null;
    if (typeof v !== "object" || v === null) return null;
    if (typeof v.firstRunAt !== "number" || !Number.isFinite(v.firstRunAt)) return null;
    return {
      firstRunAt: v.firstRunAt,
      sessionCount:
        typeof v.sessionCount === "number" && Number.isFinite(v.sessionCount)
          ? v.sessionCount
          : 0,
      lastShownAt:
        typeof v.lastShownAt === "number" && Number.isFinite(v.lastShownAt)
          ? v.lastShownAt
          : null,
      dismissCount:
        typeof v.dismissCount === "number" && Number.isFinite(v.dismissCount)
          ? v.dismissCount
          : 0,
      submitted: v.submitted === true,
    };
  } catch {
    return null;
  }
}

export function loadPromptState(): FeedbackPromptState | null {
  try {
    return parsePromptState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function savePromptState(state: FeedbackPromptState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — the prompt just re-evaluates next launch.
  }
}

// ---------------------------------------------------------------------------
// Boot wiring.

/** Post-boot deferral before the card appears, so it never races the
 *  projects/editor first render (same shape as the updater's boot check). */
const SHOW_DELAY_MS = 15_000;

let promptArmed = false;

/**
 * Record this session and, when the trigger fires, raise the feedback card
 * after the UI has settled. Called once from AppShell's onMount; returns a
 * cancel fn for teardown. No-op in the detached preview window.
 */
export function scheduleFeedbackPrompt(): () => void {
  if (promptArmed || isPreviewWindow) return () => {};
  promptArmed = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dispose = createRoot((dispose) => {
    // One-shot: waits for settings.json to hydrate (the onboarded flag),
    // records the session, rolls the dice, then disposes itself.
    createEffect(() => {
      if (!settingsLoaded()) return;
      const onboardedAtBoot = onboarded();
      const state = recordSession(loadPromptState(), Date.now());
      savePromptState(state);
      const show = shouldShowPrompt(state, {
        now: Date.now(),
        random: Math.random,
        promptsEnabled: feedbackPromptsEnabled(),
        onboardingCompleted: onboardedAtBoot,
        onboardedThisSession: !onboardedAtBoot,
      });
      if (show) {
        timer = setTimeout(() => {
          timer = null;
          // Re-check the setting at fire time — it may have been toggled off
          // (locally or via settings sync) during the deferral.
          if (!feedbackPromptsEnabled() || !onboarded()) return;
          savePromptState(markShown(loadPromptState() ?? state, Date.now()));
          setRequestFeedbackCard("prompted");
        }, SHOW_DELAY_MS);
      }
      dispose();
    });
    return dispose;
  });
  return () => {
    dispose();
    if (timer) clearTimeout(timer);
  };
}

import { describe, expect, it } from "vitest";

import {
  COOLDOWN_DAYS,
  type FeedbackPromptState,
  MAX_DISMISSALS,
  MIN_DAYS_SINCE_FIRST_RUN,
  MIN_SESSIONS,
  SHOW_CHANCE,
  initialPromptState,
  markDismissed,
  markShown,
  markSubmitted,
  parsePromptState,
  recordSession,
  shouldShowPrompt,
} from "./feedback-prompt";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);

/** A state that satisfies every eligibility gate at `now`. */
function eligibleState(overrides: Partial<FeedbackPromptState> = {}): FeedbackPromptState {
  return {
    firstRunAt: T0,
    sessionCount: MIN_SESSIONS,
    lastShownAt: null,
    dismissCount: 0,
    submitted: false,
    ...overrides,
  };
}

/** Inputs that pass every non-state gate; RNG always under the threshold. */
function passingInput(overrides: Partial<Parameters<typeof shouldShowPrompt>[1]> = {}) {
  return {
    now: T0 + MIN_DAYS_SINCE_FIRST_RUN * DAY_MS,
    random: () => 0,
    promptsEnabled: true,
    onboardingCompleted: true,
    onboardedThisSession: false,
    ...overrides,
  };
}

describe("shouldShowPrompt eligibility boundaries", () => {
  it("shows when every gate passes", () => {
    expect(shouldShowPrompt(eligibleState(), passingInput())).toBe(true);
  });

  it("requires at least 7 days since first run (exact boundary)", () => {
    const justUnder = passingInput({ now: T0 + MIN_DAYS_SINCE_FIRST_RUN * DAY_MS - 1 });
    expect(shouldShowPrompt(eligibleState(), justUnder)).toBe(false);
    const exactly = passingInput({ now: T0 + MIN_DAYS_SINCE_FIRST_RUN * DAY_MS });
    expect(shouldShowPrompt(eligibleState(), exactly)).toBe(true);
  });

  it("requires at least 5 sessions (exact boundary)", () => {
    expect(
      shouldShowPrompt(eligibleState({ sessionCount: MIN_SESSIONS - 1 }), passingInput()),
    ).toBe(false);
    expect(
      shouldShowPrompt(eligibleState({ sessionCount: MIN_SESSIONS }), passingInput()),
    ).toBe(true);
  });

  it("gates on the injected RNG at the show chance", () => {
    expect(
      shouldShowPrompt(eligibleState(), passingInput({ random: () => SHOW_CHANCE - 0.001 })),
    ).toBe(true);
    expect(
      shouldShowPrompt(eligibleState(), passingInput({ random: () => SHOW_CHANCE })),
    ).toBe(false);
    expect(
      shouldShowPrompt(eligibleState(), passingInput({ random: () => 0.99 })),
    ).toBe(false);
  });

  it("never shows within 30 days of the last showing (exact boundary)", () => {
    const now = T0 + 90 * DAY_MS;
    const shownRecently = eligibleState({ lastShownAt: now - COOLDOWN_DAYS * DAY_MS + 1 });
    expect(shouldShowPrompt(shownRecently, passingInput({ now }))).toBe(false);
    const shownLongAgo = eligibleState({ lastShownAt: now - COOLDOWN_DAYS * DAY_MS });
    expect(shouldShowPrompt(shownLongAgo, passingInput({ now }))).toBe(true);
  });

  it("stops permanently after 3 dismissals without engagement", () => {
    expect(
      shouldShowPrompt(eligibleState({ dismissCount: MAX_DISMISSALS - 1 }), passingInput()),
    ).toBe(true);
    expect(
      shouldShowPrompt(eligibleState({ dismissCount: MAX_DISMISSALS }), passingInput()),
    ).toBe(false);
    expect(
      shouldShowPrompt(eligibleState({ dismissCount: MAX_DISMISSALS + 5 }), passingInput()),
    ).toBe(false);
  });

  it("stops permanently after one successful submission", () => {
    expect(
      shouldShowPrompt(eligibleState({ submitted: true }), passingInput()),
    ).toBe(false);
  });

  it("never shows when the setting is off", () => {
    expect(
      shouldShowPrompt(eligibleState(), passingInput({ promptsEnabled: false })),
    ).toBe(false);
  });

  it("never shows before onboarding or in the session onboarding ran", () => {
    expect(
      shouldShowPrompt(eligibleState(), passingInput({ onboardingCompleted: false })),
    ).toBe(false);
    expect(
      shouldShowPrompt(eligibleState(), passingInput({ onboardedThisSession: true })),
    ).toBe(false);
  });
});

describe("state transitions", () => {
  it("recordSession seeds firstRunAt once and counts every app start", () => {
    const first = recordSession(null, T0);
    expect(first.firstRunAt).toBe(T0);
    expect(first.sessionCount).toBe(1);
    const second = recordSession(first, T0 + DAY_MS);
    expect(second.firstRunAt).toBe(T0);
    expect(second.sessionCount).toBe(2);
  });

  it("markShown/markDismissed/markSubmitted update exactly their field", () => {
    const base = eligibleState();
    expect(markShown(base, T0 + 1).lastShownAt).toBe(T0 + 1);
    expect(markDismissed(base).dismissCount).toBe(1);
    expect(markSubmitted(base).submitted).toBe(true);
    // Inputs are never mutated.
    expect(base.lastShownAt).toBeNull();
    expect(base.dismissCount).toBe(0);
    expect(base.submitted).toBe(false);
  });

  it("a failed submission counts as shown but not submitted", () => {
    // The wiring marks shown at raise time; a submit failure adds nothing, so
    // the cooldown applies while the submitted stop does not.
    const now = T0 + 60 * DAY_MS;
    const shown = markShown(eligibleState(), now);
    expect(shown.submitted).toBe(false);
    expect(shouldShowPrompt(shown, passingInput({ now: now + DAY_MS }))).toBe(false);
    expect(
      shouldShowPrompt(shown, passingInput({ now: now + (COOLDOWN_DAYS + 1) * DAY_MS })),
    ).toBe(true);
  });
});

describe("parsePromptState (localStorage boundary)", () => {
  it("roundtrips a serialized state", () => {
    const state = markShown(recordSession(null, T0), T0 + DAY_MS);
    expect(parsePromptState(JSON.stringify(state))).toEqual(state);
  });

  it("degrades garbage to null instead of throwing", () => {
    expect(parsePromptState(null)).toBeNull();
    expect(parsePromptState("")).toBeNull();
    expect(parsePromptState("not json {")).toBeNull();
    expect(parsePromptState("42")).toBeNull();
    expect(parsePromptState(JSON.stringify({ sessionCount: 3 }))).toBeNull(); // no firstRunAt
  });

  it("coerces malformed fields to safe defaults", () => {
    const parsed = parsePromptState(
      JSON.stringify({
        firstRunAt: T0,
        sessionCount: "many",
        lastShownAt: "yesterday",
        dismissCount: null,
        submitted: "yes",
      }),
    );
    expect(parsed).toEqual(initialPromptState(T0));
  });
});

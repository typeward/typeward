import { describe, expect, it, vi } from "vitest";

// Pins the discovery-ON composition so the flag flip at Pro launch restores
// the plan step AFTER the (always-shipped) account step. Same pattern as
// pro-dialog.test.tsx; the shipped OFF default is pinned by
// onboarding-account-step.test.tsx.
vi.mock("~/config/pro", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/config/pro")>()),
  PRO_DISCOVERY_ENABLED: true,
}));

// Only STEP_ORDER is under test; stub the screen's router import so the
// module evaluates without a Router (and without the router's createAsync
// import tripping over the vitest solid-js alias).
vi.mock("@solidjs/router", () => ({
  useNavigate: () => () => {},
}));

import { STEP_ORDER } from "./OnboardingScreen";

describe("onboarding STEP_ORDER (Pro discovery on)", () => {
  it("returns the plan step after the account step", () => {
    expect(STEP_ORDER).toEqual(["welcome", "engines", "account", "plan"]);
  });
});

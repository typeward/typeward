import { describe, expect, it, vi } from "vitest";

// Only STEP_ORDER is under test; stub the screen's router import so the
// module evaluates without a Router (and without the router's createAsync
// import tripping over the vitest solid-js alias).
vi.mock("@solidjs/router", () => ({
  useNavigate: () => () => {},
}));

import { STEP_ORDER } from "./OnboardingScreen";

describe("onboarding STEP_ORDER", () => {
  it("welcomes, checks the engines, and finishes there", () => {
    expect(STEP_ORDER).toEqual(["welcome", "engines"]);
  });
});

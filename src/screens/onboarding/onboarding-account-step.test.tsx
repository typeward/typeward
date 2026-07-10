import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PRO_DISCOVERY_ENABLED } from "~/config/pro";

// The account step must render against a real-looking session boundary
// without booting supabase-js: swap the session module for a settable box
// (set per test BEFORE render — the box isn't reactive) and pretend the
// build is configured so the sign-in form renders instead of the
// "isn't configured" note.
const auth = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
}));

// The screen only takes useNavigate from the router; mocking it beats
// standing up a MemoryRouter (whose createAsync import trips over the
// vitest solid-js alias).
const routerSpies = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@solidjs/router", () => ({
  useNavigate: () => routerSpies.navigate,
}));

vi.mock("~/integrations/supabase/session", () => ({
  supabaseSession: () => auth.session,
  supabaseSessionReady: () => true,
  supabaseUser: () => auth.session?.user ?? null,
  startSupabaseSession: () => {},
  signOut: async () => {},
}));

vi.mock("~/integrations/supabase/client", () => ({
  supabaseEnabled: () => true,
  getSupabaseClient: () => null,
}));

vi.mock("~/ipc", async () => {
  const { ipcMock } = await import("~/test/ipc-mock");
  return ipcMock({
    // settings-store hydrates at import; defaults apply to an empty object.
    loadSettings: async () => ({}) as import("~/ipc").AppSettings,
    saveSettings: async () => {},
    // EnginesPane probes on mount; finish() re-probes before completing.
    detectTex: async () => ({ engines: [], anyLatexAvailable: false }),
  });
});

import OnboardingScreen, { STEP_ORDER } from "./OnboardingScreen";
import { onboarded } from "~/stores/settings-store";

// Pins the shipped free-only-beta composition. skipIf keeps the suite green
// when PRO_DISCOVERY_ENABLED flips at Pro launch;
// onboarding-steps-discovery-on.test.ts pins the ON-path composition.
describe.skipIf(PRO_DISCOVERY_ENABLED)("onboarding STEP_ORDER (Pro discovery off)", () => {
  it("puts the account step after engines, before completion", () => {
    expect(STEP_ORDER).toEqual(["welcome", "engines", "account"]);
  });
});

const renderScreen = () => render(() => <OnboardingScreen />);

const gotoAccountStep = async (screen: ReturnType<typeof renderScreen>) => {
  fireEvent.click(await screen.findByText("Continue")); // welcome → engines
  fireEvent.click(await screen.findByText("Continue")); // engines → account
  await screen.findByText("Take your settings anywhere");
};

describe("onboarding account step", () => {
  beforeEach(() => {
    auth.session = null;
  });

  it("signed out: shows the real sign-in form, create-account link, and Skip for now", async () => {
    const screen = renderScreen();
    await gotoAccountStep(screen);

    // The shared SignInForm (the app's single auth path), not a bespoke one.
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.getByText("Create an account")).toBeTruthy();

    // Skipping is the footer action; the primary Continue only returns
    // once signed in.
    expect(screen.getByText("Skip for now")).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("signed out: Skip for now advances (completes onboarding as the last step)", async () => {
    const screen = renderScreen();
    await gotoAccountStep(screen);

    fireEvent.click(screen.getByText("Skip for now"));
    await waitFor(() => expect(onboarded()).toBe(true));
    expect(routerSpies.navigate).toHaveBeenCalledWith("/projects");
  });

  it("signed in: shows the identity, sync-on confirmation, and Continue instead of Skip", async () => {
    auth.session = { user: { email: "ada@example.com" } };
    const screen = renderScreen();
    await gotoAccountStep(screen);

    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByText(/Settings sync is on/)).toBeTruthy();

    expect(screen.getByText("Continue")).toBeTruthy();
    expect(screen.queryByText("Skip for now")).toBeNull();
  });
});

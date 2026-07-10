import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestProDialog_,
  setRequestProDialog,
} from "~/commands/palette-store";
import {
  resetEntitlementSource,
  setEntitlementSource,
} from "~/integrations/entitlements";
import type { EntitlementSource } from "~/integrations/types";
import { proGate } from "./pro-gate";
import { ProDialog } from "./ProDialog";

// This suite pins the discovery-ON behavior (chips gate through to the
// dialog) so the layer that returns at Pro launch stays guarded while the
// shipped default is off. The free-only-beta defaults are covered by
// pro-discovery-off.test.tsx.
vi.mock("~/config/pro", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/config/pro")>()),
  PRO_DISCOVERY_ENABLED: true,
}));

const proSource: EntitlementSource = {
  current: () => "pro",
  has: () => true,
  reasonIfMissing: () => undefined,
};

afterEach(() => {
  setRequestProDialog(false);
  resetEntitlementSource();
});

describe("proGate", () => {
  it("blocks locked actions on the free tier and raises the ProDialog request", () => {
    expect(proGate("formats.typst")).toBe(false);
    expect(requestProDialog_()).toBe(true);
  });

  it("lets entitled actions through without opening the dialog", () => {
    setEntitlementSource(proSource);
    expect(proGate("formats.typst")).toBe(true);
    expect(requestProDialog_()).toBe(false);
  });
});

describe("ProDialog", () => {
  it("shows the feature matrix, pricing, and Get Pro CTA on the free tier", async () => {
    render(() => <ProDialog />);
    setRequestProDialog(true);

    // Kobalte portals into document.body.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Typeward Pro");
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Typst");
    expect(text).toContain("Cloud sync");
    expect(text).toContain("14-day free trial");
    expect(text).toContain("Get Pro");
  });

  it("shows the you're-on-Pro state instead of the pitch on the pro tier", async () => {
    setEntitlementSource(proSource);
    render(() => <ProDialog />);
    setRequestProDialog(true);

    await waitFor(() => {
      expect(document.body.textContent).toContain("You're on Pro");
    });
    expect(document.body.textContent).not.toContain("Get Pro");
  });
});

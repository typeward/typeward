import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import {
  requestProDialog_,
  setRequestProDialog,
} from "~/commands/palette-store";
import { PRO_DISCOVERY_ENABLED } from "~/config/pro";
import { resetEntitlementSource } from "~/integrations/entitlements";
import { proGate } from "./pro-gate";
import { ProChip, ProLockedPanel } from "./ProChip";

afterEach(() => {
  setRequestProDialog(false);
  resetEntitlementSource();
});

// Free-only beta defaults (PRO_DISCOVERY_ENABLED = false): no chip, no
// locked panel, no dialog request. skipIf keeps the suite green when the
// flag flips at Pro launch; pro-dialog.test.tsx pins the discovery-on path.
describe.skipIf(PRO_DISCOVERY_ENABLED)("Pro discovery disabled", () => {
  it("proGate still blocks locked actions but never raises the ProDialog request", () => {
    expect(proGate("formats.typst")).toBe(false);
    expect(requestProDialog_()).toBe(false);
  });

  it("ProChip renders nothing", () => {
    const { container } = render(() => <ProChip />);
    expect(container.innerHTML).toBe("");
  });

  it("ProLockedPanel renders nothing", () => {
    const { container } = render(() => <ProLockedPanel />);
    expect(container.innerHTML).toBe("");
  });
});

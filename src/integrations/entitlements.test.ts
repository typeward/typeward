import { afterEach, describe, expect, it } from "vitest";

import {
  EntitlementMissingError,
  assertEntitlement,
  currentTier,
  hasEntitlement,
  resetEntitlementSource,
  setEntitlementSource,
} from "./entitlements";
import { KNOWN_ENTITLEMENT_KEYS, type EntitlementSource } from "./types";

// The free tier is the core LaTeX editor only (repriced 2026-07-08) — the
// fallback source must mirror seed.sql's free plan exactly.
const FREE_GRANTED = new Set<string>(["templates.builtin.free"]);

const proSource: EntitlementSource = {
  current: () => "pro",
  has: () => true,
  reasonIfMissing: () => undefined,
};

afterEach(() => {
  resetEntitlementSource();
});

describe("free-tier fallback source", () => {
  it("reports the free tier", () => {
    expect(currentTier()).toBe("free");
  });

  it("grants exactly the free matrix across every known key", () => {
    for (const key of KNOWN_ENTITLEMENT_KEYS) {
      expect(hasEntitlement(key), key).toBe(FREE_GRANTED.has(key));
    }
  });

  it("denies the repriced keys that used to be free", () => {
    expect(hasEntitlement("formats.typst")).toBe(false);
    expect(hasEntitlement("integrations.references.zotero.local")).toBe(false);
    expect(hasEntitlement("integrations.references.doi_lookup")).toBe(false);
    expect(hasEntitlement("integrations.vcs.git")).toBe(false);
    expect(hasEntitlement("integrations.vcs.github")).toBe(false);
    expect(hasEntitlement("integrations.vcs.overleaf_import")).toBe(false);
    expect(hasEntitlement("integrations.ai.ollama")).toBe(false);
    expect(hasEntitlement("integrations.grammar.harper")).toBe(false);
    expect(hasEntitlement("templates.custom.max")).toBe(false);
  });

  it("assertEntitlement throws a no-account EntitlementMissingError for Pro keys", () => {
    expect(() => assertEntitlement("templates.builtin.free")).not.toThrow();
    let caught: unknown;
    try {
      assertEntitlement("formats.typst");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EntitlementMissingError);
    expect((caught as EntitlementMissingError).reason).toBe("no-account");
  });
});

describe("source swap", () => {
  it("setEntitlementSource unlocks and resetEntitlementSource restores the fallback", () => {
    setEntitlementSource(proSource);
    expect(currentTier()).toBe("pro");
    expect(hasEntitlement("formats.typst")).toBe(true);
    expect(hasEntitlement("integrations.vcs.git")).toBe(true);

    resetEntitlementSource();
    expect(currentTier()).toBe("free");
    expect(hasEntitlement("formats.typst")).toBe(false);
  });
});

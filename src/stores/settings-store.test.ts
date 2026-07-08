import { describe, expect, it } from "vitest";
import {
  buildSettings,
  noteInstallId,
  setShareCrashReports,
  setUpdatesCheckAutomatically,
  validEnum,
} from "./settings-store";
import { THEMES, type Theme } from "~/themes/theme-store";

// settings.json is an external boundary: values written by older builds
// (removed themes, renamed sorts) must fall back instead of being applied
// verbatim and re-persisted forever.
describe("settings-store validEnum", () => {
  it("passes through values in the allowed set", () => {
    expect(validEnum<Theme>("lamplight", THEMES, "daylight")).toBe("lamplight");
  });

  it("falls back for values from removed features", () => {
    expect(validEnum<Theme>("obsidian", THEMES, "daylight")).toBe("daylight");
    expect(validEnum<Theme>("catppuccin", THEMES, "daylight")).toBe("daylight");
  });

  it("falls back for garbage", () => {
    expect(validEnum<Theme>("", THEMES, "daylight")).toBe("daylight");
    expect(
      validEnum("nonsense", ["cards", "list"] as const, "cards"),
    ).toBe("cards");
  });
});

// privacy.installId is Rust-owned (minted on first crash-report submission);
// the TS serializer must carry it through buildSettings() or every settings
// save after a submission would clobber the persisted id.
describe("settings-store privacy roundtrip", () => {
  it("omits installId until one exists, then preserves it across saves", () => {
    // Order matters within this test: module state is shared, so assert the
    // absent case before minting.
    expect(buildSettings().privacy?.installId).toBeUndefined();
    expect(buildSettings().privacy?.shareCrashReports).toBe(false);

    noteInstallId("11111111-2222-4333-8444-555555555555");
    setShareCrashReports(true);
    const out = buildSettings();
    expect(out.privacy?.installId).toBe("11111111-2222-4333-8444-555555555555");
    expect(out.privacy?.shareCrashReports).toBe(true);

    // A later toggle-only change keeps carrying the id.
    setShareCrashReports(false);
    expect(buildSettings().privacy?.installId).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
  });

  it("ignores empty/null ids from failed scans", () => {
    noteInstallId(null);
    noteInstallId(undefined);
    noteInstallId("");
    expect(buildSettings().privacy?.installId).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
  });
});

// The updater's auto-check toggle is a persisted field like any other; assert
// the FieldSpec carries it through buildSettings() (default ON).
describe("settings-store updates roundtrip", () => {
  it("defaults checkAutomatically on and persists changes", () => {
    expect(buildSettings().updates?.checkAutomatically).toBe(true);
    setUpdatesCheckAutomatically(false);
    expect(buildSettings().updates?.checkAutomatically).toBe(false);
    // Restore for other suites sharing module state.
    setUpdatesCheckAutomatically(true);
  });
});

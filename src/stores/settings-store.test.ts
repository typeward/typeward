import { describe, expect, it } from "vitest";
import {
  buildSettings,
  hydrateSettings,
  noteInstallId,
  setHistoryMaxVersions,
  setShareCrashReports,
  setUiScale,
  setUpdatesCheckAutomatically,
  validEnum,
} from "./settings-store";
import type { AppSettings } from "~/ipc";
import { THEMES, type Theme } from "~/themes/theme-store";

/**
 * A settings.json as the loader hands it to `hydrateSettings`: the current
 * store state with one dotted key overridden, so each test asserts on the
 * field it cares about while the rest of the tree stays realistic.
 */
function loadedWith(key: string, value: unknown): AppSettings {
  const snapshot = buildSettings() as unknown as Record<string, unknown>;
  const parts = key.split(".");
  let cursor = snapshot;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = { ...(cursor[part] as Record<string, unknown>) };
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return snapshot as unknown as AppSettings;
}

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

// File-history retention persists like any other field; the 10–200 clamp
// (mirroring the Rust load-boundary clamp in settings.rs) runs on every
// hydrate path. Default 50.
describe("settings-store history retention", () => {
  it("defaults to 50 and persists changes", () => {
    expect(buildSettings().history?.maxVersionsPerFile).toBe(50);
    setHistoryMaxVersions(120);
    expect(buildSettings().history?.maxVersionsPerFile).toBe(120);
    setHistoryMaxVersions(50);
  });

  it("clamps out-of-range and non-numeric persisted values", () => {
    hydrateSettings(loadedWith("history.maxVersionsPerFile", 3));
    expect(buildSettings().history?.maxVersionsPerFile).toBe(10);

    hydrateSettings(loadedWith("history.maxVersionsPerFile", 5000));
    expect(buildSettings().history?.maxVersionsPerFile).toBe(200);

    hydrateSettings(loadedWith("history.maxVersionsPerFile", "plenty"));
    expect(buildSettings().history?.maxVersionsPerFile).toBe(50);
  });

  it("backfills the default when settings.json predates the section", () => {
    setHistoryMaxVersions(120);
    hydrateSettings(loadedWith("history", undefined));
    expect(buildSettings().history?.maxVersionsPerFile).toBe(50);
  });
});

// visualModeLatex rides the `editor` key: default off, roundtrips through
// buildSettings(), and the merge-over-defaults validate backfills it for
// settings.json files predating the field.
describe("settings-store visualModeLatex roundtrip", () => {
  it("defaults off and persists changes", () => {
    expect(buildSettings().editor.visualModeLatex).toBe(false);
    hydrateSettings(
      loadedWith("editor", { ...buildSettings().editor, visualModeLatex: true }),
    );
    expect(buildSettings().editor.visualModeLatex).toBe(true);
    hydrateSettings(
      loadedWith("editor", { ...buildSettings().editor, visualModeLatex: false }),
    );
    expect(buildSettings().editor.visualModeLatex).toBe(false);
  });

  it("backfills the default when an older editor blob lacks the field", () => {
    const { visualModeLatex: _omitted, ...older } = buildSettings().editor;
    hydrateSettings(loadedWith("editor", older));
    expect(buildSettings().editor.visualModeLatex).toBe(false);
  });
});

// The `editor` blob crosses to Rust as a single object and serde drops every
// key its struct doesn't declare, so a field added here but not to
// settings.rs is written on save and silently gone on the next load — the
// setting reverting itself on every launch. Pinning the key set makes adding
// one a deliberate three-place change (here, ipc.AppSettings, settings.rs).
describe("settings-store editor persisted shape", () => {
  it("persists exactly the fields the Rust struct declares", () => {
    expect(Object.keys(buildSettings().editor).sort()).toEqual([
      "autoCloseBrackets",
      "autoCompile",
      "autocomplete",
      "autosaveDelayMs",
      "autosaveEnabled",
      "bracketMatching",
      "fontSize",
      "highlightActiveLine",
      "lineHeight",
      "lineNumbers",
      "lineWrap",
      "pdfDefaultZoom",
      "pdfInvertDark",
      "stopOnFirstError",
      "tabSize",
      "vimMode",
      "visualModeLatex",
    ]);
  });

  it("round-trips autosaveEnabled instead of snapping back to the default", () => {
    expect(buildSettings().editor.autosaveEnabled).toBe(true);
    hydrateSettings(
      loadedWith("editor", { ...buildSettings().editor, autosaveEnabled: false }),
    );
    expect(buildSettings().editor.autosaveEnabled).toBe(false);
    hydrateSettings(
      loadedWith("editor", { ...buildSettings().editor, autosaveEnabled: true }),
    );
    expect(buildSettings().editor.autosaveEnabled).toBe(true);
  });

  it("backfills the default when an older editor blob lacks the toggle", () => {
    const { autosaveEnabled: _omitted, ...older } = buildSettings().editor;
    hydrateSettings(loadedWith("editor", older));
    expect(buildSettings().editor.autosaveEnabled).toBe(true);
  });
});

// "system" is a persisted theme SETTING (resolves to daylight/lamplight at
// render time) — the load boundary must accept it and round-trip it verbatim,
// never the resolved theme.
describe("settings-store theme setting", () => {
  it("accepts and round-trips the system option", () => {
    hydrateSettings(loadedWith("theme", "system"));
    expect(buildSettings().theme).toBe("system");
    hydrateSettings(loadedWith("theme", "daylight"));
    expect(buildSettings().theme).toBe("daylight");
  });
});

// Interface scale persists like any other field; the load boundary snaps to
// the picker's 90–150 step-5 grid and non-numeric garbage lands on 100.
describe("settings-store interface scale", () => {
  it("defaults to 100 and persists changes", () => {
    expect(buildSettings().ui.uiScale).toBe(100);
    setUiScale(120);
    expect(buildSettings().ui.uiScale).toBe(120);
    setUiScale(100);
  });

  it("snaps and clamps persisted values", () => {
    hydrateSettings(loadedWith("ui.uiScale", 87));
    expect(buildSettings().ui.uiScale).toBe(90);

    hydrateSettings(loadedWith("ui.uiScale", 40));
    expect(buildSettings().ui.uiScale).toBe(90);

    hydrateSettings(loadedWith("ui.uiScale", 500));
    expect(buildSettings().ui.uiScale).toBe(150);

    hydrateSettings(loadedWith("ui.uiScale", "huge"));
    expect(buildSettings().ui.uiScale).toBe(100);
  });
});

// hydrateSettings is the boundary a settings.json crosses on the way in — a
// file from an older/newer build must hit the enum fallbacks and clamps, not
// the signals directly.
describe("settings-store hydrateSettings", () => {
  it("applies a valid value through the field's setter", () => {
    hydrateSettings(loadedWith("updates.checkAutomatically", false));
    expect(buildSettings().updates?.checkAutomatically).toBe(false);
    setUpdatesCheckAutomatically(true);
  });

  it("runs loaded values through validation", () => {
    hydrateSettings(loadedWith("workspace.defaultView", "not-a-view"));
    expect(buildSettings().workspace.defaultView).toBe("cards");
    hydrateSettings(loadedWith("workspace.defaultView", "list"));
    expect(buildSettings().workspace.defaultView).toBe("list");
    hydrateSettings(loadedWith("workspace.defaultView", "cards"));
  });

  it("drops sections from newer builds instead of choking on them", () => {
    hydrateSettings(loadedWith("someFutureSection", { enabled: true }));
    expect(buildSettings().updates?.checkAutomatically).toBe(true);
    expect(
      (buildSettings() as unknown as Record<string, unknown>).someFutureSection,
    ).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  formatShortcutForDisplay,
  matches,
  shortcutTokens,
} from "./shortcuts";

// The `isMac` flag is decided once at module load from navigator.platform.
// vitest's jsdom env reports a non-Mac platform, so these tests cover the
// non-Mac branch; the Mac branch is covered by inspection.

const event = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent("keydown", init);

describe("shortcuts.matches", () => {
  it("matches Mod+K on non-Mac via ctrlKey", () => {
    expect(matches(event({ key: "k", ctrlKey: true }), "Mod+K")).toBe(true);
  });

  it("does not match Mod+K without the modifier", () => {
    expect(matches(event({ key: "k" }), "Mod+K")).toBe(false);
  });

  it("respects Shift requirement", () => {
    expect(
      matches(event({ key: "P", ctrlKey: true, shiftKey: true }), "Mod+Shift+P"),
    ).toBe(true);
    expect(matches(event({ key: "p", ctrlKey: true }), "Mod+Shift+P")).toBe(
      false,
    );
  });

  it("normalizes Escape/Enter aliases", () => {
    expect(matches(event({ key: "Escape" }), "Escape")).toBe(true);
    expect(matches(event({ key: "Enter", ctrlKey: true }), "Mod+Enter")).toBe(
      true,
    );
  });

  it("returns false when no key is in the shortcut", () => {
    expect(matches(event({ key: "k", ctrlKey: true }), "Mod+Shift+")).toBe(
      false,
    );
  });
});

describe("shortcuts display helpers", () => {
  it("renders Mod+K as Ctrl+K on non-Mac", () => {
    expect(formatShortcutForDisplay("Mod+K")).toBe("Ctrl+K");
  });

  it("splits into per-key tokens for <kbd> chips", () => {
    expect(shortcutTokens("Mod+Shift+Enter")).toEqual(["Ctrl", "Shift", "↵"]);
  });

  it("falls back to the raw string when shortcut has no key after modifiers", () => {
    // "Mod+" parses to a modifier with no key → null → return raw input.
    expect(formatShortcutForDisplay("Mod+")).toBe("Mod+");
    expect(shortcutTokens("Mod+")).toEqual(["Mod+"]);
  });

  it("treats a bare key as a no-modifier shortcut", () => {
    expect(formatShortcutForDisplay("Escape")).toBe("esc");
  });
});

// Smoke-test the Mac branch by stubbing navigator.platform before re-import.
describe("shortcuts on Mac", () => {
  it("renders Mod+K as ⌘K when running on Mac", async () => {
    vi.resetModules();
    Object.defineProperty(globalThis.navigator, "platform", {
      configurable: true,
      get: () => "MacIntel",
    });
    const mod = await import("./shortcuts");
    expect(mod.isMac).toBe(true);
    expect(mod.formatShortcutForDisplay("Mod+K")).toBe("⌘K");
    expect(
      mod.matches(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        "Mod+K",
      ),
    ).toBe(true);
    // Restore for any later tests.
    Object.defineProperty(globalThis.navigator, "platform", {
      configurable: true,
      get: () => "Win32",
    });
  });
});

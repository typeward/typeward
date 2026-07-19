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

  it("matches literal Ctrl combos off-Mac via ctrlKey", () => {
    // Off-Mac, Mod and literal Ctrl share the physical key, so the tab-cycle
    // bindings behave identically to a Mod combo here.
    expect(matches(event({ key: "Tab", ctrlKey: true }), "Ctrl+Tab")).toBe(true);
    expect(matches(event({ key: "Tab" }), "Ctrl+Tab")).toBe(false);
    expect(
      matches(event({ key: "Tab", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+Tab"),
    ).toBe(true);
    expect(
      matches(event({ key: "Tab", ctrlKey: true }), "Ctrl+Shift+Tab"),
    ).toBe(false);
  });
});

describe("shortcuts display helpers", () => {
  it("renders Mod+K as Ctrl+K on non-Mac", () => {
    expect(formatShortcutForDisplay("Mod+K")).toBe("Ctrl+K");
  });

  it("splits into per-key tokens for <kbd> chips", () => {
    expect(shortcutTokens("Mod+Shift+Enter")).toEqual(["Ctrl", "Shift", "↵"]);
  });

  it("renders literal Ctrl as Ctrl off-Mac", () => {
    expect(formatShortcutForDisplay("Ctrl+Tab")).toBe("Ctrl+Tab");
    expect(shortcutTokens("Ctrl+Shift+Tab")).toEqual(["Ctrl", "Shift", "Tab"]);
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
    // Multi-modifier order follows the HIG: ⌥⇧⌘ with Command last.
    expect(mod.formatShortcutForDisplay("Mod+Shift+F")).toBe("⇧⌘F");
    expect(mod.shortcutTokens("Mod+Shift+Enter")).toEqual(["⇧", "⌘", "↵"]);
    expect(
      mod.matches(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        "Mod+K",
      ),
    ).toBe(true);
    // Literal Ctrl stays the physical Control key on Mac — never folds
    // into ⌘ — and renders as ⌃ (first in the HIG order).
    expect(
      mod.matches(
        new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }),
        "Ctrl+Tab",
      ),
    ).toBe(true);
    expect(
      mod.matches(
        new KeyboardEvent("keydown", { key: "Tab", metaKey: true }),
        "Ctrl+Tab",
      ),
    ).toBe(false);
    expect(mod.formatShortcutForDisplay("Ctrl+Tab")).toBe("⌃Tab");
    // Restore for any later tests.
    Object.defineProperty(globalThis.navigator, "platform", {
      configurable: true,
      get: () => "Win32",
    });
  });
});

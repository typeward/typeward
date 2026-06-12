import { describe, expect, it } from "vitest";
import { validEnum } from "./settings-store";
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

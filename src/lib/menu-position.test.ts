import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./menu-position";

const base = {
  menuWidth: 220,
  menuHeight: 300,
  viewportWidth: 1280,
  viewportHeight: 800,
};

describe("clampMenuPosition", () => {
  it("leaves a position that already fits untouched", () => {
    expect(clampMenuPosition({ ...base, x: 100, y: 100 })).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("pulls the menu left of the right edge with the pad gap", () => {
    expect(clampMenuPosition({ ...base, x: 1200, y: 100 })).toEqual({
      x: 1280 - 220 - 8,
      y: 100,
    });
  });

  it("pulls the menu above the bottom edge with the pad gap", () => {
    expect(clampMenuPosition({ ...base, x: 100, y: 780 })).toEqual({
      x: 100,
      y: 800 - 300 - 8,
    });
  });

  it("clamps both axes independently on a corner click", () => {
    expect(clampMenuPosition({ ...base, x: 1279, y: 799 })).toEqual({
      x: 1280 - 220 - 8,
      y: 800 - 300 - 8,
    });
  });

  it("never pushes past the top-left pad when the menu is taller/wider than the viewport", () => {
    expect(
      clampMenuPosition({
        x: 50,
        y: 50,
        menuWidth: 500,
        menuHeight: 500,
        viewportWidth: 400,
        viewportHeight: 300,
      }),
    ).toEqual({ x: 8, y: 8 });
  });

  it("keeps a fitting position exactly at the pad boundary", () => {
    // x + width == viewportWidth - pad is the last position that still fits.
    expect(
      clampMenuPosition({ ...base, x: 1280 - 220 - 8, y: 800 - 300 - 8 }),
    ).toEqual({ x: 1052, y: 492 });
  });

  it("respects a custom pad", () => {
    expect(clampMenuPosition({ ...base, x: 1279, y: 100, pad: 16 })).toEqual({
      x: 1280 - 220 - 16,
      y: 100,
    });
  });
});

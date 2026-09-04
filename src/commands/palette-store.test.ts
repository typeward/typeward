import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  navigateTo,
  paletteOpen_,
  requestNewProject_,
  setNavigator,
  setPaletteOpen,
  setRequestNewProject,
  togglePalette,
} from "./palette-store";

describe("palette-store", () => {
  beforeEach(() => {
    setPaletteOpen(false);
    setRequestNewProject(false);
    setNavigator(() => {});
  });

  it("toggles palette open state", () => {
    expect(paletteOpen_()).toBe(false);
    togglePalette();
    expect(paletteOpen_()).toBe(true);
    togglePalette();
    expect(paletteOpen_()).toBe(false);
  });

  it("flips the new-project intent flag", () => {
    setRequestNewProject(true);
    expect(requestNewProject_()).toBe(true);
    setRequestNewProject(false);
    expect(requestNewProject_()).toBe(false);
  });

  it("routes through the registered navigator", () => {
    const spy = vi.fn();
    setNavigator(spy);
    navigateTo("/somewhere");
    expect(spy).toHaveBeenCalledWith("/somewhere");
  });

  it("silently no-ops when no navigator is set", () => {
    setNavigator(null as unknown as (path: string) => void);
    // Just shouldn't throw.
    expect(() => navigateTo("/wherever")).not.toThrow();
  });
});

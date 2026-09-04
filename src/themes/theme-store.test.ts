import { describe, it, expect, beforeEach } from "vitest";
import { setTheme, setAccent, theme, accent } from "./theme-store";

// Solid signals persist across tests in the same module — explicitly reset.
beforeEach(async () => {
  setTheme("aurora");
  setAccent("violet-cyan");
  await Promise.resolve();
  localStorage.clear();
});

describe("theme-store", () => {
  it("does not set data-theme for Aurora (the tokens.css :root baseline)", () => {
    expect(theme()).toBe("aurora");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("sets data-theme on <html> when a non-baseline theme is selected", async () => {
    setTheme("lamplight");
    await Promise.resolve();
    expect(theme()).toBe("lamplight");
    expect(document.documentElement.getAttribute("data-theme")).toBe("lamplight");
  });

  it("sets data-theme for the Daylight default theme", async () => {
    setTheme("daylight");
    await Promise.resolve();
    expect(document.documentElement.getAttribute("data-theme")).toBe("daylight");
  });

  it("removes data-accent when switching back to violet-cyan", async () => {
    setAccent("amber-rose");
    await Promise.resolve();
    expect(document.documentElement.getAttribute("data-accent")).toBe(
      "amber-rose",
    );
    setAccent("violet-cyan");
    await Promise.resolve();
    expect(accent()).toBe("violet-cyan");
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });

  it("persists theme + accent to localStorage", async () => {
    setTheme("paper");
    setAccent("emerald-teal");
    await Promise.resolve();
    const raw = localStorage.getItem("typeward.theme");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ theme: "paper", accent: "emerald-teal" });
  });
});

import { describe, it, expect } from "vitest";
import { computeFitScale } from "./zoom";

describe("computeFitScale", () => {
  const page = { w: 612, h: 792 }; // US Letter, PDF points

  it("fits width using clientWidth minus padding", () => {
    const s = computeFitScale({ clientWidth: 660, clientHeight: 1000 }, page, "fit-width");
    expect(s).toBeCloseTo((660 - 48) / 612, 5);
  });

  it("fits page using clientHeight minus padding", () => {
    const s = computeFitScale({ clientWidth: 1000, clientHeight: 824 }, page, "fit-page");
    expect(s).toBeCloseTo((824 - 32) / 792, 5);
  });

  it("clamps to the [0.25, 4] range", () => {
    expect(computeFitScale({ clientWidth: 20, clientHeight: 20 }, page, "fit-width")).toBe(0.25);
    expect(computeFitScale({ clientWidth: 100000, clientHeight: 20 }, page, "fit-width")).toBe(4);
  });

  it("degenerate page dims fall back to 1", () => {
    expect(computeFitScale({ clientWidth: 800, clientHeight: 800 }, { w: 0, h: 0 }, "fit-width")).toBe(1);
  });
});

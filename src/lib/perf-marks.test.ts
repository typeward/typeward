import { describe, expect, it } from "vitest";
import { perfDiscard, perfMark, perfMeasure } from "./perf-marks";

describe("perf-marks", () => {
  it("measures only against a pending mark", () => {
    expect(perfMeasure("m.none", "never-marked")).toBeNull();
    perfMark("t.start");
    const ms = perfMeasure("m.once", "t.start");
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(0);
  });

  it("records once per mark instance, again after a re-mark", () => {
    perfMark("t.dedupe");
    expect(perfMeasure("m.dedupe", "t.dedupe")).not.toBeNull();
    expect(perfMeasure("m.dedupe", "t.dedupe")).toBeNull();
    perfMark("t.dedupe");
    expect(perfMeasure("m.dedupe", "t.dedupe")).not.toBeNull();
  });

  it("two measure names can consume the same mark", () => {
    perfMark("t.shared");
    expect(perfMeasure("m.first", "t.shared")).not.toBeNull();
    expect(perfMeasure("m.second", "t.shared")).not.toBeNull();
  });

  it("drops stale marks past maxAgeMs", () => {
    perfMark("t.stale");
    expect(perfMeasure("m.stale", "t.stale", undefined, -1)).toBeNull();
    expect(perfMeasure("m.stale", "t.stale", undefined, 60_000)).toBeNull();
  });

  it("discard clears a pending mark", () => {
    perfMark("t.discard");
    perfDiscard("t.discard");
    expect(perfMeasure("m.discard", "t.discard")).toBeNull();
  });

  it("exposes the ring on window", () => {
    expect(window.__typewardPerf?.entries).toBeDefined();
  });
});

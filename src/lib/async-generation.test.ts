import { describe, expect, it } from "vitest";
import { createAsyncGenerationGuard } from "./async-generation";

describe("createAsyncGenerationGuard", () => {
  it("invalidates older async generations when a newer one starts", () => {
    const guard = createAsyncGenerationGuard();

    const first = guard.next();
    const second = guard.next();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("can invalidate the current generation without starting another", () => {
    const guard = createAsyncGenerationGuard();
    const current = guard.next();

    guard.invalidate();

    expect(current.isCurrent()).toBe(false);
  });
});

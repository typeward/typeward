import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  const now = Date.UTC(2026, 6, 5, 12, 0, 0);

  it("reports sub-45s spans as 'just now'", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 44 * SEC, now)).toBe("just now");
  });

  it("reports minutes under an hour", () => {
    expect(relativeTime(now - 45 * SEC, now)).toBe("1m ago");
    expect(relativeTime(now - 5 * MIN, now)).toBe("5m ago");
    expect(relativeTime(now - 59 * MIN, now)).toBe("59m ago");
  });

  it("reports hours under a day", () => {
    expect(relativeTime(now - 1 * HOUR, now)).toBe("1h ago");
    expect(relativeTime(now - 2 * HOUR, now)).toBe("2h ago");
    expect(relativeTime(now - 23 * HOUR, now)).toBe("23h ago");
  });

  it("reports days under a week", () => {
    expect(relativeTime(now - 1 * DAY, now)).toBe("1d ago");
    expect(relativeTime(now - 6 * DAY, now)).toBe("6d ago");
  });

  it("falls back to a short date past a week", () => {
    const label = relativeTime(now - 30 * DAY, now);
    expect(label).not.toMatch(/ago|just now/);
  });

  it("omits the year for same-year dates and includes it otherwise", () => {
    const sameYear = relativeTime(Date.UTC(2026, 0, 1, 12, 0, 0), now);
    expect(sameYear).not.toMatch(/2026/);
    const priorYear = relativeTime(Date.UTC(2024, 5, 1, 12, 0, 0), now);
    expect(priorYear).toMatch(/2024/);
  });
});

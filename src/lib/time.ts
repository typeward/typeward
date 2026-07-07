/**
 * Human-friendly timestamp helpers for the library card/row chrome. Static
 * render (no ticking interval) — the Projects screen refetches on every mount,
 * which is fresh enough. Short-date labels mirror `deadlines.ts` (year shown
 * only when it differs from the current year).
 */

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Coarse "time ago" phrase; falls back to a short absolute date past a week. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 45 * SEC) return "just now";
  if (diff < HOUR) return `${Math.round(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.round(diff / DAY)}d ago`;

  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full absolute stamp for title attributes, e.g. "Jul 5, 2026, 14:02". */
export function absoluteStamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
